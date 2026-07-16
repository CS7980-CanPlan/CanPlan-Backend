import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireAnyGroup, requireGroup } from '../../shared/auth';
import { requireCaller } from '../../shared/authz';
import { batchGet } from '../../shared/batch';
import { getOwnedCategory } from '../../shared/category';
import { loadProfile, supportLinkIneffectiveReason } from '../../shared/delegation';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  assertUsableOrganization,
  getOrganization as loadOrganization,
  isTransactConditionCheckFailure,
  organizationConditionCheck,
  organizationMemberDelete,
  organizationMemberPut,
  stripOrganization,
} from '../../shared/organization';
import {
  ensureOrganizationMembershipId,
  type MembershipTransition,
  planMembershipTransition,
  revokeSupportLinksForOrganizationChange,
} from '../../shared/organizationMembership';
import {
  categorySk,
  DEFAULT_CATEGORY_COLOR,
  DEFAULT_CATEGORY_NAME,
  ENTITY,
  ENTITY_TYPE_INDEX,
  incomingSupportLinkSk,
  isDefaultCategoryName,
  META_SK,
  ORG_INDEX,
  organizationPk,
  PROFILE_SK,
  supporterPk,
  USER_LINK_PREFIX,
  userLinkSk,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../shared/response';
import { PRIMARY_USER_GROUP, roleFromIdentity, SUPPORT_PERSON_GROUP } from '../../shared/roles';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Category,
  Connection,
  CreateMyUserProfileInput,
  Organization,
  SelectPrimaryUserInput,
  SupportLink,
  SupportLinkRevocationReason,
  UnselectPrimaryUserInput,
  UpdateMyUserProfileInput,
  UserProfile,
} from '../../shared/types';

/**
 * Users domain Lambda — UserProfile + SupportLink operations plus the read-only
 * organization directory, routed by the resolved GraphQL field. One Lambda per domain
 * keeps cold-start surface and IAM roles small while preserving the repo's
 * one-resolver-per-field wiring.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<
  | UserProfile
  | SupportLink
  | Organization
  | Connection<UserProfile>
  | Connection<SupportLink>
  | Connection<Organization>
  | null
> => {
  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    case 'createUserProfile':
      return createMyUserProfile(identity, args.input as CreateMyUserProfileInput);
    case 'updateMyUserProfile':
      return updateMyUserProfile(identity, args.input as UpdateMyUserProfileInput);
    case 'getUserProfile':
      return getUserProfile(args.userId as string);
    case 'listMyOrganizationUsers':
      return listMyOrganizationUsers(identity, pageArgs(args));
    case 'listAvailableOrganizations':
      return listAvailableOrganizations(identity, pageArgs(args));
    case 'getOrganization':
      return getOrganizationDirectoryEntry(identity, args.organizationId as string);
    case 'selectPrimaryUser':
      return selectPrimaryUser(identity, args.input as SelectPrimaryUserInput);
    case 'unselectPrimaryUser':
      return unselectPrimaryUser(identity, args.input as UnselectPrimaryUserInput);
    case 'listMySupportList':
      return listMySupportList(identity, pageArgs(args));
    case 'listMySupportLinkHistory':
      return listMySupportLinkHistory(identity, pageArgs(args));
    default:
      throw new Error(`users handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/**
 * Create the signed-in caller's OWN profile. Identity is the source of truth:
 * `userId` comes from the Cognito `sub`, `email` from the caller's email claim, and
 * `role` is derived from Cognito group membership (see roleFromIdentity). No
 * client-supplied id, email, or role is accepted — a caller cannot create a profile
 * for someone else or pick their own role.
 *
 * Every profile owns EXACTLY ONE real default Category named "No Category" (a normal
 * Category row with its own UUID + `isDefault: true`, `taskCount: 0`). Concurrency-safe:
 *  - If the profile already has a valid default category, only the editable profile fields
 *    are overwritten and the existing `defaultCategoryId` is preserved (no second default).
 *  - If it has none, the profile and its default category are created in ONE transaction
 *    (profile guarded by `attribute_not_exists(PK)`); if a concurrent first call wins the
 *    race (TransactionCanceledException), we reread and reuse the now-existing default
 *    instead of creating a duplicate.
 *  - If the stored `defaultCategoryId` points at a missing/invalid row, we fail clearly and
 *    direct the operator to the migration (we never silently create a duplicate default).
 *
 * Organization membership follows the SupportLink lifecycle rules on EVERY call, including
 * repeated calls for an existing profile: a real join/move mints a fresh internal
 * organizationMembershipId and revokes affected ACTIVE SupportLinks; leaving clears the id
 * and revokes; re-supplying the current organizationId keeps the existing membership session
 * (initializing it lazily for a legacy profile) and revokes nothing.
 */
async function createMyUserProfile(
  identity: AppSyncIdentity | undefined,
  input: CreateMyUserProfileInput,
): Promise<UserProfile> {
  const userId = requireCaller(identity);

  // Throws ValidationError unless the caller has exactly one base-role group.
  const role = roleFromIdentity(identity);
  const email = (identity?.claims?.email as string | undefined)?.trim();
  const displayName = input?.displayName?.trim();
  if (!displayName) throw new ValidationError('displayName is required and cannot be empty');

  // organizationId references a real Organization: omitted ⇒ none; a non-empty value must
  // name an existing, non-deleting org (validated before any profile work); blank ⇒ rejected.
  const organizationId = await resolveCreateOrganization(input?.organizationId);

  const editable = {
    role,
    displayName,
    email,
    organizationId,
    accessibilitySettings: input?.accessibilitySettings,
  };

  const existing = await getProfile(userId);

  // Profile already has a default — validate it, then overwrite only the editable fields
  // (carrying the existing task counters forward so a re-create never resets them).
  if (existing?.defaultCategoryId) {
    await assertValidDefaultCategory(userId, existing.defaultCategoryId);
    return putProfile(
      userId,
      editable,
      existing.defaultCategoryId,
      existing.createdAt,
      { taskCount: existing.taskCount, nextTaskOrder: existing.nextTaskOrder },
      existing,
    );
  }

  // No valid default yet → create the default category alongside the profile, atomically.
  // A brand-new profile starts the per-owner task counters at 0 / 1.
  const previousOrg = existing?.organizationId?.trim() || undefined;
  const transition = planMembershipTransition(
    previousOrg,
    existing?.organizationMembershipId,
    organizationId,
  );
  const defaultCategoryId = randomUUID();
  const now = new Date().toISOString();
  const profile = buildProfile(
    userId,
    editable,
    defaultCategoryId,
    existing?.createdAt ?? now,
    now,
    {
      taskCount: existing?.taskCount ?? 0,
      nextTaskOrder: existing?.nextTaskOrder ?? 1,
    },
  );
  if (transition.kind === 'keep' || transition.kind === 'rotate') {
    profile.organizationMembershipId = transition.membershipId;
  }

  // Profile write: create-only when there is no profile yet; otherwise (a legacy profile
  // missing its default) set the default on the existing row, guarded so it's set once and
  // bound to the org seen at pre-read so a concurrent org change (which may have rotated the
  // membership session) cancels the write instead of resurrecting stale membership state.
  const profileWrite = existing
    ? legacyDefaultProfileUpdate(
        userId,
        editable,
        defaultCategoryId,
        now,
        previousOrg,
        existing.organizationMembershipId,
        transition,
      )
    : {
        Put: {
          TableName: TABLE_NAME,
          Item: { PK: userPk(userId), SK: PROFILE_SK, entityType: ENTITY.USER_PROFILE, ...profile },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      };

  const defaultCategory: Category = {
    categoryId: defaultCategoryId,
    ownerId: userId,
    name: DEFAULT_CATEGORY_NAME,
    color: DEFAULT_CATEGORY_COLOR,
    isDefault: true,
    taskCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const transactItems: Array<Record<string, unknown>> = [
    profileWrite,
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: userPk(userId),
          SK: categorySk(defaultCategoryId),
          entityType: ENTITY.CATEGORY,
          ...defaultCategory,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];
  // When joining an org, atomically re-verify it still exists and isn't deleting — closing the
  // race where adminDeleteOrganization removes it between the pre-read and this write — and write
  // the strongly-consistent OrganizationMember row in the SAME transaction so the org partition
  // always reflects this new member.
  const orgCheckIndex = organizationId ? transactItems.length : -1;
  if (organizationId) {
    transactItems.push(organizationConditionCheck(organizationId));
    transactItems.push(organizationMemberPut(organizationId, userId));
  }
  // A legacy profile that was in a DIFFERENT org (or is being cleared here) must drop its stale
  // membership row in the same transaction. Unconditional delete → harmless no-op if none exists.
  if (previousOrg && previousOrg !== organizationId) {
    transactItems.push(organizationMemberDelete(previousOrg, userId));
  }

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    // The org was deleted/began deleting between the pre-read and the write.
    if (organizationId && isTransactConditionCheckFailure(err, orgCheckIndex)) {
      throw organizationUnavailableError(organizationId);
    }
    // A concurrent first call already created the profile + default (or set the default on
    // a legacy row). Reread and reuse it rather than minting a second default category.
    if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;
    const reread = await getProfile(userId);
    if (!reread?.defaultCategoryId) {
      // A legacy-row Update canceled by its org guard (not by a concurrent default): the
      // profile's org changed concurrently — surface the precise retryable error.
      if (existing && isTransactConditionCheckFailure(err, 0))
        throw await profileGuardFailure(userId);
      throw err;
    }
    await assertValidDefaultCategory(userId, reread.defaultCategoryId);
    return putProfile(
      userId,
      editable,
      reread.defaultCategoryId,
      reread.createdAt,
      { taskCount: reread.taskCount, nextTaskOrder: reread.nextTaskOrder },
      reread,
    );
  }
  // The write committed — now soft-revoke the ACTIVE SupportLinks an actual org change
  // invalidated (no-op when the organization did not change).
  await revokeAfterMembershipChange(userId, organizationId, transition);
  return profile;
}

/**
 * The profile Update for a legacy profile that exists but has no default category yet:
 * overwrite the editable fields, stamp the default exactly once, and apply the membership
 * transition — same-org keeps (or lazily, if-absent initializes) organizationMembershipId,
 * a join/move rotates it, and clearing REMOVEs organizationId + organizationMembershipId
 * (never writing a NULL attribute, which would defeat attribute_not_exists guards).
 */
function legacyDefaultProfileUpdate(
  userId: string,
  editable: EditableProfile,
  defaultCategoryId: string,
  now: string,
  previousOrg: string | undefined,
  previousMembershipId: string | undefined,
  transition: MembershipTransition,
): Record<string, unknown> {
  const setParts = [
    '#role = :role',
    'displayName = :displayName',
    'email = :email',
    'accessibilitySettings = :accessibilitySettings',
    'defaultCategoryId = :defaultCategoryId',
    'updatedAt = :now',
  ];
  const removeParts: string[] = [];
  const values: Record<string, unknown> = {
    ':role': editable.role,
    ':displayName': editable.displayName,
    ':email': editable.email ?? null,
    ':accessibilitySettings': editable.accessibilitySettings ?? null,
    ':defaultCategoryId': defaultCategoryId,
    ':now': now,
  };

  if (editable.organizationId) {
    setParts.push('organizationId = :organizationId');
    values[':organizationId'] = editable.organizationId;
  } else {
    removeParts.push('organizationId');
  }
  if (transition.kind === 'keep') {
    // Same org: never rotate; a legacy profile without an id initializes it lazily and
    // concurrency-safely (if_not_exists resolves on the live item, so one stable id wins).
    setParts.push(
      'organizationMembershipId = if_not_exists(organizationMembershipId, :membershipId)',
    );
    values[':membershipId'] = transition.membershipId;
  } else if (transition.kind === 'rotate') {
    setParts.push('organizationMembershipId = :membershipId');
    values[':membershipId'] = transition.membershipId;
  } else {
    removeParts.push('organizationMembershipId');
  }

  const guard = profileOrgGuardExpression(previousOrg, previousMembershipId, values);
  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length) updateExpression += ` REMOVE ${removeParts.join(', ')}`;

  return {
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      UpdateExpression: updateExpression,
      ConditionExpression: `attribute_exists(PK) AND attribute_not_exists(defaultCategoryId) AND ${guard}`,
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: values,
    },
  };
}

/**
 * The organization named by a membership write vanished or began deleting between the pre-read
 * (assertUsableOrganization) and the atomic ConditionCheck — a clear, client-handleable error
 * rather than a raw TransactionCanceledException surfacing as an internal failure.
 */
function organizationUnavailableError(organizationId: string): ValidationError {
  return new ValidationError(
    `organization ${organizationId} is no longer available (it was deleted or is being deleted) ` +
      'and cannot be joined',
  );
}

/** Read the caller's profile row (undefined if it doesn't exist). */
async function getProfile(userId: string): Promise<UserProfile | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      ConsistentRead: true,
    }),
  );
  return result.Item as UserProfile | undefined;
}

/**
 * Validate a create-time organizationId reference. Omitted (undefined) ⇒ the profile joins no
 * org; a blank string ⇒ ValidationError; otherwise the id must name an existing, non-deleting
 * Organization (else NotFound/Validation from assertUsableOrganization). Returns the trimmed id.
 */
async function resolveCreateOrganization(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  const organizationId = raw.trim();
  if (!organizationId) throw new ValidationError('organizationId cannot be empty');
  await assertUsableOrganization(organizationId);
  return organizationId;
}

/** The profile's editable, server-derived fields (everything except id/keys/default/timestamps). */
type EditableProfile = Pick<
  UserProfile,
  'role' | 'displayName' | 'email' | 'organizationId' | 'accessibilitySettings'
>;

/** Per-owner task counters threaded through profile writes (undefined ⇒ omitted from the row). */
type TaskCounters = Pick<UserProfile, 'taskCount' | 'nextTaskOrder'>;

function buildProfile(
  userId: string,
  editable: EditableProfile,
  defaultCategoryId: string,
  createdAt: string,
  updatedAt: string,
  counters: TaskCounters,
): UserProfile {
  return { userId, ...editable, defaultCategoryId, ...counters, createdAt, updatedAt };
}

/**
 * A conditional-expression fragment binding a profile write to the exact org-membership state
 * seen at pre-read — organization id PLUS membership-session id (or explicit absence of either).
 * Every org-membership write carries it so a concurrent leave/move/rejoin — including an ABA
 * return to the same org under a new session — cancels the write instead of silently resurrecting
 * stale membership state or orphaning an OrganizationMember row. Mutates `values` with the
 * placeholders the fragment needs.
 */
function profileOrgGuardExpression(
  previousOrg: string | undefined,
  previousMembershipId: string | undefined,
  values: Record<string, unknown>,
): string {
  if (previousOrg) {
    values[':prevOrg'] = previousOrg;
    if (previousMembershipId) {
      values[':prevMembershipId'] = previousMembershipId;
      return 'organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId';
    }
    return 'organizationId = :prevOrg AND attribute_not_exists(organizationMembershipId)';
  }
  return 'attribute_not_exists(organizationId)';
}

/**
 * The profile's org changed (or the profile disappeared) between the pre-read and the write.
 * Re-reads to give the precise repository-standard error: NotFound for a missing profile, a
 * retryable ValidationError for a concurrent organization change.
 */
async function profileGuardFailure(userId: string): Promise<Error> {
  const profile = await getProfile(userId);
  if (!profile) return new NotFoundError(`profile for user ${userId} not found`);
  return new ValidationError(
    `user ${userId}'s organization changed concurrently; re-read and retry`,
  );
}

/**
 * After a successful org-membership write, soft-revoke the ACTIVE SupportLinks the change
 * invalidated (both directions). `rotate` passes the fresh membership id so a link legitimately
 * selected under the NEW session is never revoked; `clear` revokes every ACTIVE link. No-op
 * when the organization did not actually change. Runs after the profile transaction commits —
 * if a crash interrupts it, the untouched links are already ineffective (their membership
 * snapshot no longer matches) and a later change re-runs the sweep.
 */
async function revokeAfterMembershipChange(
  userId: string,
  currentOrganizationId: string | undefined,
  transition: MembershipTransition,
): Promise<void> {
  if (!transition.organizationChanged) return;
  await revokeSupportLinksForOrganizationChange(userId, {
    organizationId: currentOrganizationId,
    organizationMembershipId: transition.kind === 'rotate' ? transition.membershipId : undefined,
  });
}

/**
 * Overwrite the editable profile fields, preserving the existing default + createdAt + task
 * counters (a full Put replaces the item, so the counters must be re-supplied or they'd drop).
 *
 * `previous` is the profile state read BEFORE this write. Because a full Put also rewrites
 * organizationId, membership state must be kept in step: setting an org writes its
 * OrganizationMember row (guarded by an org existence/not-deleting ConditionCheck), any change
 * that MOVES to a different org or CLEARS it deletes the previous org's membership row — all
 * atomically with the profile Put — and the internal organizationMembershipId follows the
 * membership-session rules (kept on same-org, lazily initialized for legacy rows, rotated on a
 * join/move, dropped on a leave, with affected ACTIVE SupportLinks revoked after the write).
 * The Put is bound to the org seen at pre-read so a concurrent org change aborts it.
 */
async function putProfile(
  userId: string,
  editable: EditableProfile,
  defaultCategoryId: string,
  createdAt: string,
  counters: TaskCounters,
  previous: Pick<UserProfile, 'organizationId' | 'organizationMembershipId'> | undefined,
): Promise<UserProfile> {
  const prevOrg = previous?.organizationId?.trim() || undefined;
  const newOrg = editable.organizationId;
  const transition = planMembershipTransition(prevOrg, previous?.organizationMembershipId, newOrg);

  // Same-org lazy init cannot ride a full Put (a Put cannot express if_not_exists), so
  // initialize on the EXISTING row first — concurrent initializers converge on one stored id —
  // and carry the authoritative value into the Put.
  let membershipId: string | undefined;
  if (transition.kind === 'keep') {
    membershipId = transition.initialized
      ? await ensureOrganizationMembershipId(userId, newOrg as string)
      : transition.membershipId;
  } else if (transition.kind === 'rotate') {
    membershipId = transition.membershipId;
  }

  const profile = buildProfile(
    userId,
    editable,
    defaultCategoryId,
    createdAt,
    new Date().toISOString(),
    counters,
  );
  if (membershipId) profile.organizationMembershipId = membershipId;
  const item = { PK: userPk(userId), SK: PROFILE_SK, entityType: ENTITY.USER_PROFILE, ...profile };
  const guardValues: Record<string, unknown> = {};
  // A same-org legacy profile was initialized just above in a separate conditional update.
  // Bind the following full Put to the authoritative id returned by that update; guarding on
  // the pre-init absence would make the Put reject its own successful initialization.
  const membershipIdAtWrite =
    transition.kind === 'keep' && transition.initialized
      ? membershipId
      : previous?.organizationMembershipId;
  const guard = profileOrgGuardExpression(prevOrg, membershipIdAtWrite, guardValues);

  // Setting organizationId? The Put must be atomic with an org existence/not-deleting check so a
  // profile rewrite can't join an org that adminDeleteOrganization is concurrently removing, and it
  // must write the OrganizationMember row (and drop the old org's row when moving) in one transaction.
  if (newOrg) {
    const transactItems: Array<Record<string, unknown>> = [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: item,
          ConditionExpression: guard,
          ...(Object.keys(guardValues).length ? { ExpressionAttributeValues: guardValues } : {}),
        },
      },
      organizationConditionCheck(newOrg),
      organizationMemberPut(newOrg, userId),
    ];
    if (prevOrg && prevOrg !== newOrg) {
      transactItems.push(organizationMemberDelete(prevOrg, userId));
    }
    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      if (isTransactConditionCheckFailure(err, 1)) throw organizationUnavailableError(newOrg);
      if (isTransactConditionCheckFailure(err, 0)) throw await profileGuardFailure(userId);
      throw err;
    }
    await revokeAfterMembershipChange(userId, newOrg, transition);
    return profile;
  }

  // Not setting an org, but the profile previously had one: the full Put clears organizationId
  // (and the membership session), so delete the now-stale membership row in the same transaction
  // (no org check needed to clear) and revoke the links the departure invalidated.
  if (prevOrg) {
    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE_NAME,
                Item: item,
                ConditionExpression: guard,
                ExpressionAttributeValues: guardValues,
              },
            },
            organizationMemberDelete(prevOrg, userId),
          ],
        }),
      );
    } catch (err) {
      if (isTransactConditionCheckFailure(err, 0)) throw await profileGuardFailure(userId);
      throw err;
    }
    await revokeAfterMembershipChange(userId, undefined, transition);
    return profile;
  }

  // No org before or after: a plain Put, still bound to "no org" so a concurrent join (which
  // wrote a membership row + session) cannot be silently wiped.
  try {
    await dynamo.send(
      new PutCommand({ TableName: TABLE_NAME, Item: item, ConditionExpression: guard }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw await profileGuardFailure(userId);
    }
    throw err;
  }
  return profile;
}

/**
 * Verify a profile's stored `defaultCategoryId` points at a real row owned by the user with
 * `isDefault: true` and the reserved name. A missing/invalid pointer is a hard failure
 * (run the migration to repair) — we never silently create a duplicate default.
 */
async function assertValidDefaultCategory(
  userId: string,
  defaultCategoryId: string,
): Promise<void> {
  const category = await getOwnedCategory(userId, defaultCategoryId);
  const valid =
    !!category && category.isDefault === true && isDefaultCategoryName(category.name ?? '');
  if (!valid) {
    throw new ValidationError(
      `profile's defaultCategoryId (${defaultCategoryId}) does not point at a valid default ` +
        'category; run the category migration to repair it',
    );
  }
}

/** Strip internal storage attributes (PK/SK/entityType) before returning a profile. */
function stripProfile(item: Record<string, unknown>): UserProfile {
  const out = { ...item };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  return out as unknown as UserProfile;
}

/**
 * Partial update of the SIGNED-IN caller's OWN profile. The caller is derived from the
 * Cognito `sub` (never a client-supplied userId), so a caller can only edit their own row.
 *
 * Distinct from createUserProfile: this NEVER creates a profile or a default category, NEVER
 * touches role/email/defaultCategoryId/createdAt/keys/entityType, and is a targeted
 * UpdateCommand (not a full-item Put) so every untouched field is preserved. Editable fields:
 *  - `displayName`: omitted ⇒ unchanged; otherwise trimmed (null/empty/whitespace rejected).
 *  - `accessibilitySettings`: omitted ⇒ unchanged; explicit `null` ⇒ cleared (REMOVE); a
 *    non-null value ⇒ FULL replacement of the stored value (never deep-merged). It arrives
 *    already parsed from the AWSJSON argument and is stored as-is; AppSync re-serializes it
 *    to an AWSJSON string on the way out.
 *  - `organizationId` (MVP self-service): omitted ⇒ unchanged; non-empty string ⇒ set; explicit
 *    `null` ⇒ cleared (REMOVE); a blank string is rejected. Any signed-in user may set their own.
 *
 * Organization changes drive the SupportLink lifecycle: a real JOIN, LEAVE, or MOVE rotates or
 * clears the internal organizationMembershipId and soft-revokes every affected ACTIVE
 * SupportLink (in both directions); re-setting the CURRENT org keeps the existing membership
 * session (lazily initializing a legacy profile's missing id) and invalidates no current link.
 * Rejoining later never restores revoked links — the SupportPerson must call selectPrimaryUser.
 *
 * At least one editable field must be supplied. The write is conditioned on the profile
 * existing (`attribute_exists(PK)`), so it can never create a new row; a missing profile
 * (or one removed concurrently) surfaces as NotFoundError.
 */
async function updateMyUserProfile(
  identity: AppSyncIdentity | undefined,
  input: UpdateMyUserProfileInput,
): Promise<UserProfile> {
  const userId = requireCaller(identity);

  const displayNameKeyPresent = input?.displayName !== undefined;
  const settingsKeyPresent = input?.accessibilitySettings !== undefined;
  const orgKeyPresent = input?.organizationId !== undefined;
  if (!displayNameKeyPresent && !settingsKeyPresent && !orgKeyPresent) {
    throw new ValidationError(
      'at least one of displayName, accessibilitySettings, or organizationId must be supplied',
    );
  }

  const now = new Date().toISOString();
  const setParts = ['updatedAt = :now'];
  const removeParts: string[] = [];
  const values: Record<string, unknown> = { ':now': now };

  if (displayNameKeyPresent) {
    const displayName = input.displayName?.trim();
    if (!displayName) throw new ValidationError('displayName cannot be empty');
    setParts.push('displayName = :displayName');
    values[':displayName'] = displayName;
  }

  if (settingsKeyPresent) {
    // Explicit null clears the field; any other value fully replaces the stored settings.
    if (input.accessibilitySettings === null) {
      removeParts.push('accessibilitySettings');
    } else {
      setParts.push('accessibilitySettings = :settings');
      values[':settings'] = input.accessibilitySettings;
    }
  }

  // The org id being SET (a non-null string), if any — drives the atomic org ConditionCheck.
  let orgToSet: string | undefined;
  if (orgKeyPresent) {
    // Self-service org membership: explicit null clears it; a non-empty string sets it but must
    // name an existing, non-deleting Organization (validated here — no longer free-form). A
    // blank/whitespace string is rejected (use null to clear). role/email/etc. stay locked.
    if (input.organizationId === null) {
      removeParts.push('organizationId');
    } else {
      const organizationId = input.organizationId?.trim();
      if (!organizationId) {
        throw new ValidationError('organizationId cannot be empty; use null to clear it');
      }
      await assertUsableOrganization(organizationId);
      orgToSet = organizationId;
      setParts.push('organizationId = :organizationId');
      values[':organizationId'] = organizationId;
    }
  }

  // No organizationId change (only displayName/accessibilitySettings): one conditional update.
  if (!orgKeyPresent) {
    let updateExpression = `SET ${setParts.join(', ')}`;
    if (removeParts.length) updateExpression += ` REMOVE ${removeParts.join(', ')}`;
    return runProfileUpdate(userId, {
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      UpdateExpression: updateExpression,
      // Never create a profile row — the update only applies to an existing one.
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: values,
    });
  }

  // Any change to organizationId must keep the strongly-consistent OrganizationMember rows (under
  // the org partition) AND the membership session in lockstep with UserProfile.organizationId.
  // Both need the PREVIOUS org (and membership id), so read the profile first. (A missing
  // profile is NotFound — the same result the update's attribute_exists(PK) guard would give.)
  const current = await getProfile(userId);
  if (!current) throw new NotFoundError(`profile for user ${userId} not found`);
  const previousOrg = current.organizationId?.trim() || undefined;
  const transition = planMembershipTransition(
    previousOrg,
    current.organizationMembershipId,
    orgToSet,
  );

  // Membership session: keep (lazily initializing a legacy profile via if_not_exists — atomic,
  // so concurrent initializers converge on ONE stored id), rotate on a real join/move, or clear
  // on a leave. An unchanged org never rotates and never revokes.
  if (transition.kind === 'keep') {
    setParts.push(
      'organizationMembershipId = if_not_exists(organizationMembershipId, :membershipId)',
    );
    values[':membershipId'] = transition.membershipId;
  } else if (transition.kind === 'rotate') {
    setParts.push('organizationMembershipId = :membershipId');
    values[':membershipId'] = transition.membershipId;
  } else {
    // 'clear' (leaving) and 'none' (clearing while org-less): drop any membership session.
    removeParts.push('organizationMembershipId');
  }

  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length) updateExpression += ` REMOVE ${removeParts.join(', ')}`;

  // Bind the write to the org seen at the pre-read: if a concurrent request changes the org in
  // between, the guard cancels this write instead of mixing two membership sessions.
  const guard = profileOrgGuardExpression(previousOrg, current.organizationMembershipId, values);
  const profileUpdate: ProfileUpdate = {
    TableName: TABLE_NAME,
    Key: { PK: userPk(userId), SK: PROFILE_SK },
    UpdateExpression: updateExpression,
    ConditionExpression: `attribute_exists(PK) AND ${guard}`,
    ExpressionAttributeValues: values,
  };

  const updated = orgToSet
    ? await setProfileOrganization(userId, profileUpdate, orgToSet, previousOrg)
    : await clearProfileOrganization(userId, profileUpdate, previousOrg);
  // The org actually changed → the old membership session ended: soft-revoke every affected
  // ACTIVE SupportLink (both directions). Same-org re-sets skip this entirely.
  await revokeAfterMembershipChange(userId, orgToSet, transition);
  return updated;
}

/** The conditional profile UpdateCommand shape shared by the update paths below. */
interface ProfileUpdate {
  TableName: string;
  Key: Record<string, string>;
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
}

/** Run the profile update as a single conditional UpdateCommand, returning the stored row (ALL_NEW). */
async function runProfileUpdate(
  userId: string,
  profileUpdate: ProfileUpdate,
): Promise<UserProfile> {
  try {
    const result = await dynamo.send(
      new UpdateCommand({ ...profileUpdate, ReturnValues: 'ALL_NEW' }),
    );
    return stripProfile(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`profile for user ${userId} not found`);
    }
    throw err;
  }
}

/** Read the profile back after a TransactWrite (which returns no attributes) and strip it. */
async function readBackProfile(userId: string): Promise<UserProfile> {
  const updated = await getProfile(userId);
  if (!updated) throw new NotFoundError(`profile for user ${userId} not found`);
  return stripProfile(updated as unknown as Record<string, unknown>);
}

/**
 * SET the caller's organizationId in ONE transaction: the guarded profile update + an org
 * existence/not-deleting ConditionCheck (so a concurrent adminDeleteOrganization can't slip a
 * membership onto a deleting/deleted org) + a Put of the new OrganizationMember row, and — when
 * MOVING from a different org — a Delete of the old membership row. TransactWrite returns no
 * attributes, so read the updated profile back.
 */
async function setProfileOrganization(
  userId: string,
  profileUpdate: ProfileUpdate,
  orgToSet: string,
  previousOrg: string | undefined,
): Promise<UserProfile> {
  const transactItems: Array<Record<string, unknown>> = [
    { Update: profileUpdate },
    organizationConditionCheck(orgToSet),
    organizationMemberPut(orgToSet, userId),
  ];
  if (previousOrg && previousOrg !== orgToSet) {
    transactItems.push(organizationMemberDelete(previousOrg, userId));
  }
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    // The org ConditionCheck is transact-item index 1.
    if (isTransactConditionCheckFailure(err, 1)) throw organizationUnavailableError(orgToSet);
    // Item 0 is the guarded profile Update: the profile vanished (NotFound) or its org changed
    // concurrently (retryable conflict) — re-read to report the precise one.
    if (isTransactConditionCheckFailure(err, 0)) throw await profileGuardFailure(userId);
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw await profileGuardFailure(userId);
    }
    throw err;
  }
  return readBackProfile(userId);
}

/**
 * CLEAR the caller's organizationId (and membership session). When they currently belong to an
 * org, REMOVE the attributes AND delete that OrganizationMember row in ONE transaction (then
 * read back). With no current org there is no membership row to drop, so a single conditional
 * update suffices. Idempotent.
 */
async function clearProfileOrganization(
  userId: string,
  profileUpdate: ProfileUpdate,
  previousOrg: string | undefined,
): Promise<UserProfile> {
  if (!previousOrg) return runProfileUpdate(userId, profileUpdate);
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [{ Update: profileUpdate }, organizationMemberDelete(previousOrg, userId)],
      }),
    );
  } catch (err) {
    // The only conditional item is the guarded profile Update — NotFound or concurrent change.
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw await profileGuardFailure(userId);
    }
    throw err;
  }
  return readBackProfile(userId);
}

async function getUserProfile(userId: string): Promise<UserProfile | null> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: PROFILE_SK } }),
  );
  return (result.Item as UserProfile) ?? null;
}

/**
 * listMyOrganizationUsers — the roster of users in the AUTHENTICATED caller's OWN current
 * organization. The org is read from the caller's profile (never a client argument), so a
 * caller can only ever see their own org — a SupportPerson cannot enumerate another
 * organization. Errors if the caller has no current organization. Returns the lightweight
 * orgIndex projection (userId, displayName, role).
 */
async function listMyOrganizationUsers(
  identity: AppSyncIdentity | undefined,
  page: PageArgs,
): Promise<Connection<UserProfile>> {
  const callerOrg = await requireCallerOrganization(identity);
  return queryOrgRoster(callerOrg, page);
}

/** The authenticated caller's current organizationId, or a ValidationError if they have none. */
async function requireCallerOrganization(identity: AppSyncIdentity | undefined): Promise<string> {
  const caller = requireCaller(identity);
  const profile = await loadProfile(caller);
  const organizationId = profile?.organizationId?.trim();
  if (!organizationId) {
    throw new ValidationError(
      'caller has no current organization; set one via updateMyUserProfile first',
    );
  }
  return organizationId;
}

/** Query the orgIndex roster for one organization (projects userId, displayName, role). */
function queryOrgRoster(organizationId: string, page: PageArgs): Promise<Connection<UserProfile>> {
  return queryPage<UserProfile>(
    {
      TableName: TABLE_NAME,
      IndexName: ORG_INDEX,
      KeyConditionExpression: 'organizationId = :org',
      // OrganizationMember rows also carry organizationId + userId, so they co-tenant this GSI.
      // Their SK is MEMBER#<userId>, not #PROFILE — restrict the roster to real UserProfile rows.
      // (PK/SK are the base-table key, always present in a GSI result regardless of projection.)
      FilterExpression: 'SK = :profileSk',
      ExpressionAttributeValues: { ':org': organizationId, ':profileSk': PROFILE_SK },
    },
    page,
  );
}

// ── Organization directory (PrimaryUser + SupportPerson, read-only) ────────────

/**
 * The Cognito base-role groups allowed to browse the organization directory. Deliberately
 * excludes OrganizationAdmin (no product rule grants it), API-key callers, and unauthenticated
 * callers; SystemAdmin has its own admin APIs (a SystemAdmin who ALSO holds one of these base
 * roles may naturally use the directory). Enforced at the AppSync edge via the fields'
 * @aws_cognito_user_pools(cognito_groups: […]) directives AND re-checked here — never rely on
 * the GraphQL directive alone.
 */
const ORGANIZATION_DIRECTORY_GROUPS = [PRIMARY_USER_GROUP, SUPPORT_PERSON_GROUP] as const;

/**
 * listAvailableOrganizations — the read-only directory of organizations a PrimaryUser or
 * SupportPerson may join (they join by setting their own organizationId). Queries
 * entityTypeIndex (entityType = Organization, newest-first — the same deterministic ordering
 * as the SystemAdmin listAllOrganizations; never a Scan), excludes organizations mid-deletion,
 * and strips every internal storage field (PK/SK/entityType/deleting) so only
 * organizationId/name/createdAt/updatedAt leave the Lambda.
 *
 * Pagination note: the `deleting` filter runs AFTER DynamoDB reads a page, so a page may hold
 * fewer than `limit` items (even zero) while `nextToken` is non-null. The token tracks the
 * underlying index position and stays valid — callers just keep paging until it is null.
 */
async function listAvailableOrganizations(
  identity: AppSyncIdentity | undefined,
  page: PageArgs,
): Promise<Connection<Organization>> {
  requireAnyGroup(identity, ORGANIZATION_DIRECTORY_GROUPS);
  const result = await queryPage<Organization>(
    {
      TableName: TABLE_NAME,
      IndexName: ENTITY_TYPE_INDEX,
      KeyConditionExpression: 'entityType = :et',
      // An org being deleted is not joinable and must not be offered.
      FilterExpression: 'attribute_not_exists(deleting)',
      ExpressionAttributeValues: { ':et': ENTITY.ORGANIZATION },
      ScanIndexForward: false, // newest createdAt first — matches listAllOrganizations
    },
    page,
  );
  if (result.items.length === 0) return { items: [], nextToken: result.nextToken };

  // A GSI page can briefly carry a stale pre-delete image. Re-read the page's authoritative
  // #META rows consistently so an org marked/deleted moments ago is never offered as joinable.
  const authoritative = await batchGet(
    result.items.map((organization) => ({
      PK: organizationPk(organization.organizationId),
      SK: META_SK,
    })),
  );
  const byId = new Map(
    authoritative.map((item) => [item.organizationId as string, item as unknown as Organization]),
  );
  const items = result.items
    .map((organization) => byId.get(organization.organizationId))
    .filter(
      (organization): organization is Organization => !!organization && !organization.deleting,
    )
    .map(stripOrganization);
  return { items, nextToken: result.nextToken };
}

/**
 * getOrganization — read ONE organization from the directory by id (PrimaryUser/SupportPerson).
 * Trims + validates the id, reads the base-table `ORG#<id>` / `#META` key, and returns the
 * stripped Organization. Follows the repo's get* convention of returning null (not NotFound)
 * when the organization doesn't exist — and an organization mid-deletion is treated the same
 * as absent, because it is not available to join.
 */
async function getOrganizationDirectoryEntry(
  identity: AppSyncIdentity | undefined,
  organizationId: string,
): Promise<Organization | null> {
  requireAnyGroup(identity, ORGANIZATION_DIRECTORY_GROUPS);
  const id = organizationId?.trim();
  if (!id) throw new ValidationError('organizationId is required and cannot be empty');
  const organization = await loadOrganization(id);
  if (!organization || organization.deleting) return null;
  return stripOrganization(organization);
}

// ── SupportLink selection (SupportPerson delegated access) ──────────────────────

/**
 * selectPrimaryUser — a SupportPerson explicitly selects a PRIMARY_USER in their OWN
 * organization to support, writing (or restoring) the SupportLink as ACTIVE together with the
 * organization + membership-session snapshot that makes it effective. The supporter is ALWAYS
 * the authenticated caller (never client-supplied), and membership in the Cognito
 * SupportPerson group remains the authorization source of truth for calling this. Guard rails:
 *  - only a SupportPerson may select (a primary user cannot select a supporter);
 *  - the caller must currently belong to an organization;
 *  - the target must exist, be a PRIMARY_USER, and currently share the caller's organization.
 *
 * Legacy profiles that predate membership sessions have their missing
 * organizationMembershipId initialized lazily first (a concurrency-safe, if-absent write that
 * preserves organizationId — no migration exists), and the AUTHORITATIVE stored ids are used.
 *
 * The write is a single DynamoDB transaction that condition-checks BOTH live profiles — the
 * supporter still in the expected org under the expected membership session, the target still
 * a PRIMARY_USER in that same org under ITS expected session — and upserts the link ACTIVE
 * with the snapshot. If either profile changes organization mid-selection the transaction
 * fails with a clear retryable error, so a selection can never race an org change into
 * activating a stale relationship. Idempotent: a brand-new link is created ACTIVE, and a
 * previously REVOKED link (including a legacy one without a snapshot) is restored/upgraded in
 * place, preserving its original createdAt and clearing its revocation reason. Explicit
 * re-selection is the ONLY way a revoked or legacy link becomes effective again.
 */
async function selectPrimaryUser(
  identity: AppSyncIdentity | undefined,
  input: SelectPrimaryUserInput,
): Promise<SupportLink> {
  const supporterId = requireCaller(identity);
  // Only a SupportPerson may select/unselect — a primary user cannot select a supporter.
  requireGroup(identity, SUPPORT_PERSON_GROUP);

  const primaryUserId = input?.primaryUserId?.trim();
  if (!primaryUserId) throw new ValidationError('primaryUserId is required and cannot be empty');
  if (primaryUserId === supporterId) {
    throw new ValidationError('cannot select yourself as a primary user');
  }

  const supporter = await loadProfile(supporterId);
  const supporterOrg = supporter?.organizationId?.trim();
  if (!supporter || !supporterOrg) {
    throw new ValidationError(
      'you must belong to an organization to select primary users; set one via updateMyUserProfile',
    );
  }

  const target = await loadProfile(primaryUserId);
  if (!target) throw new NotFoundError(`user ${primaryUserId} not found`);
  if (target.role !== 'PRIMARY_USER') {
    throw new ValidationError(`user ${primaryUserId} is not a primary user and cannot be selected`);
  }
  if ((target.organizationId?.trim() ?? '') !== supporterOrg) {
    throw new UnauthorizedError(`Unauthorized: user ${primaryUserId} is not in your organization`);
  }

  // Legacy profiles (org set before membership sessions existed) initialize their missing
  // organizationMembershipId lazily here; the stored value that comes back is authoritative.
  const supporterMembershipId =
    supporter.organizationMembershipId ??
    (await ensureOrganizationMembershipId(supporterId, supporterOrg));
  const primaryMembershipId =
    target.organizationMembershipId ??
    (await ensureOrganizationMembershipId(primaryUserId, supporterOrg));

  const now = new Date().toISOString();
  // Upsert ACTIVE with the selection snapshot: create if absent, or restore/upgrade a REVOKED
  // (or legacy) link in place — preserving its original createdAt. supporterId/userId are
  // (re)written so the GSIs stay populated; revokedReason is cleared on restore.
  const linkUpsert = {
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) },
      UpdateExpression:
        'SET entityType = :entityType, supporterId = :supporterId, ' +
        'primaryUserId = :primaryUserId, userId = :primaryUserId, #status = :active, ' +
        'organizationId = :org, supporterOrganizationMembershipId = :supporterMid, ' +
        'primaryUserOrganizationMembershipId = :primaryMid, ' +
        'createdAt = if_not_exists(createdAt, :now), updatedAt = :now ' +
        'REMOVE revokedReason',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':entityType': ENTITY.SUPPORT_LINK,
        ':supporterId': supporterId,
        ':primaryUserId': primaryUserId,
        ':active': 'ACTIVE',
        ':org': supporterOrg,
        ':supporterMid': supporterMembershipId,
        ':primaryMid': primaryMembershipId,
        ':now': now,
      },
    },
  };

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          // [0] The supporter is still in the expected org, under the expected session.
          {
            ConditionCheck: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(supporterId), SK: PROFILE_SK },
              ConditionExpression:
                'attribute_exists(PK) AND organizationId = :org AND organizationMembershipId = :mid',
              ExpressionAttributeValues: { ':org': supporterOrg, ':mid': supporterMembershipId },
            },
          },
          // [1] The target is still a PRIMARY_USER in that org, under ITS expected session.
          {
            ConditionCheck: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(primaryUserId), SK: PROFILE_SK },
              ConditionExpression:
                'attribute_exists(PK) AND #role = :primaryRole AND organizationId = :org ' +
                'AND organizationMembershipId = :mid',
              ExpressionAttributeNames: { '#role': 'role' },
              ExpressionAttributeValues: {
                ':primaryRole': 'PRIMARY_USER',
                ':org': supporterOrg,
                ':mid': primaryMembershipId,
              },
            },
          },
          // [2] The link upsert itself.
          linkUpsert,
          // [3] Durable reverse pointer under the primary user's base-table partition. This is
          // written atomically with the canonical link so a target-side org-change sweep can
          // discover the relationship consistently without waiting for a GSI to catch up.
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: userPk(primaryUserId),
                SK: incomingSupportLinkSk(supporterId),
                supporterId,
                primaryUserId,
              },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (isTransactConditionCheckFailure(err, 0)) {
      throw new ValidationError(
        'your organization membership changed while selecting; re-check and retry',
      );
    }
    if (isTransactConditionCheckFailure(err, 1)) {
      throw new ValidationError(
        `user ${primaryUserId}'s organization membership changed while selecting; re-check and retry`,
      );
    }
    throw err;
  }

  // TransactWrite returns no attributes — read the stored link back.
  const stored = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) },
      ConsistentRead: true,
    }),
  );
  if (!stored.Item)
    throw new NotFoundError(`support link to ${primaryUserId} not found after write`);
  return stripSupportLink(stored.Item as Record<string, unknown>);
}

/**
 * unselectPrimaryUser — a SupportPerson un-selects a primary user, SOFT-revoking the SupportLink
 * (status REVOKED, revokedReason UNSELECTED) rather than deleting it, so the original row (and
 * createdAt) survives and a later selectPrimaryUser restores it. The supporter is the
 * authenticated caller; only a SupportPerson may unselect. NotFound if no link exists for the
 * (caller, primaryUser) pair.
 */
async function unselectPrimaryUser(
  identity: AppSyncIdentity | undefined,
  input: UnselectPrimaryUserInput,
): Promise<SupportLink> {
  const supporterId = requireCaller(identity);
  requireGroup(identity, SUPPORT_PERSON_GROUP);

  const primaryUserId = input?.primaryUserId?.trim();
  if (!primaryUserId) throw new ValidationError('primaryUserId is required and cannot be empty');

  const now = new Date().toISOString();
  const reason: SupportLinkRevocationReason = 'UNSELECTED';
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) },
        UpdateExpression: 'SET #status = :revoked, revokedReason = :reason, updatedAt = :now',
        // Never create a link here — only revoke one that exists.
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'REVOKED', ':reason': reason, ':now': now },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripSupportLink(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(
        `no support link from ${supporterId} to ${primaryUserId} to unselect`,
      );
    }
    throw err;
  }
}

/**
 * listMySupportList — the SupportPerson caller's CURRENTLY EFFECTIVE support relationships:
 * only links that would actually grant delegated access right now. REVOKED links, legacy
 * ACTIVE links without a membership snapshot, and links whose snapshot no longer matches
 * either party's current organization/membership session are NOT current supported users and
 * are excluded (use listMySupportLinkHistory for unfiltered public history fields).
 *
 * Implementation: consistently pages the caller's natural SUPPORTER# base-table partition with
 * a server-side filter for the caller-side conditions (ACTIVE + selected in the caller's current
 * org under their current membership session), then consistently BatchGets the page's target
 * profiles in one call (no per-item N+1 reads) and keeps links whose target still checks out —
 * the same
 * `supportLinkIneffectiveReason` predicate delegated access enforces. Because filtering
 * happens after DynamoDB reads a page, a page may return fewer than `limit` items while
 * `nextToken` is non-null; the token tracks the underlying rows and remains valid.
 */
async function listMySupportList(
  identity: AppSyncIdentity | undefined,
  page: PageArgs,
): Promise<Connection<SupportLink>> {
  const supporterId = requireCaller(identity);
  requireGroup(identity, SUPPORT_PERSON_GROUP);
  const supporter = await loadProfile(supporterId);
  const supporterOrg = supporter?.organizationId?.trim();
  const supporterMembershipId = supporter?.organizationMembershipId;
  // No profile, no organization, or no membership session yet ⇒ nothing can be effective:
  // every effective link snapshots the supporter's CURRENT membership id at selection time.
  if (!supporter || !supporterOrg || !supporterMembershipId) {
    return { items: [], nextToken: null };
  }

  const linkPage = await queryPage<SupportLink>(
    {
      TableName: TABLE_NAME,
      // SupportLinks already live under the caller's natural partition. A consistent base-table
      // query avoids a just-revoked GSI image being presented as currently effective.
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ConsistentRead: true,
      // Caller-side effectiveness, filtered server-side: ACTIVE, selected in the caller's
      // current org, under the caller's current membership session.
      FilterExpression:
        '#status = :active AND organizationId = :org AND supporterOrganizationMembershipId = :mid',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pk': supporterPk(supporterId),
        ':prefix': USER_LINK_PREFIX,
        ':active': 'ACTIVE',
        ':org': supporterOrg,
        ':mid': supporterMembershipId,
      },
    },
    page,
  );
  if (linkPage.items.length === 0) return { items: [], nextToken: linkPage.nextToken };

  // Target-side effectiveness needs the targets' live profiles — one BatchGet per page.
  const targetIds = [...new Set(linkPage.items.map((link) => link.primaryUserId))];
  const profiles = (await batchGet(
    targetIds.map((id) => ({ PK: userPk(id), SK: PROFILE_SK })),
  )) as unknown as UserProfile[];
  const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));

  const items = linkPage.items.filter(
    (link) =>
      supportLinkIneffectiveReason(link, supporter, profilesByUserId.get(link.primaryUserId)) ===
      null,
  );
  return { items, nextToken: linkPage.nextToken };
}

/**
 * listMySupportLinkHistory — the authenticated SupportPerson caller's unfiltered public
 * SupportLink history (every primary user they have ever selected: ACTIVE, REVOKED, and legacy
 * links alike), read consistently from their natural SUPPORTER# base-table partition. Presence
 * here says NOTHING about current delegated access — use listMySupportList for the currently
 * effective relationships.
 */
async function listMySupportLinkHistory(
  identity: AppSyncIdentity | undefined,
  page: PageArgs,
): Promise<Connection<SupportLink>> {
  const supporterId = requireCaller(identity);
  requireGroup(identity, SUPPORT_PERSON_GROUP);
  return queryPage<SupportLink>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ConsistentRead: true,
      ExpressionAttributeValues: { ':pk': supporterPk(supporterId), ':prefix': USER_LINK_PREFIX },
    },
    page,
  );
}

/** Strip internal storage attributes (PK/SK/entityType) before returning a SupportLink. */
function stripSupportLink(item: Record<string, unknown>): SupportLink {
  const out = { ...item };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  return out as unknown as SupportLink;
}
