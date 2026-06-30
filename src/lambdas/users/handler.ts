import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireGroup } from '../../shared/auth';
import { requireCaller } from '../../shared/authz';
import { getOwnedCategory } from '../../shared/category';
import { loadProfile } from '../../shared/delegation';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  categorySk,
  DEFAULT_CATEGORY_COLOR,
  DEFAULT_CATEGORY_NAME,
  ENTITY,
  isDefaultCategoryName,
  ORG_INDEX,
  PROFILE_SK,
  SUPPORTER_INDEX,
  supporterPk,
  userLinkSk,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../shared/response';
import { roleFromIdentity, SUPPORT_PERSON_GROUP } from '../../shared/roles';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Category,
  Connection,
  CreateMyUserProfileInput,
  CreateSupportLinkInput,
  SelectPrimaryUserInput,
  SupportLink,
  UnselectPrimaryUserInput,
  UpdateMyUserProfileInput,
  UserProfile,
} from '../../shared/types';

/**
 * Users domain Lambda — UserProfile + SupportLink operations, routed by the
 * resolved GraphQL field. One Lambda per domain keeps cold-start surface and IAM
 * roles small while preserving the repo's one-resolver-per-field wiring.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<
  UserProfile | SupportLink | Connection<UserProfile> | Connection<SupportLink> | null
> => {
  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    case 'createUserProfile':
      return createMyUserProfile(identity, args.input as CreateMyUserProfileInput);
    case 'updateMyUserProfile':
      return updateMyUserProfile(identity, args.input as UpdateMyUserProfileInput);
    case 'getUserProfile':
      return getUserProfile(args.userId as string);
    case 'listUsersByOrganization':
      return listUsersByOrganization(identity, args.organizationId as string, pageArgs(args));
    case 'listMyOrganizationUsers':
      return listMyOrganizationUsers(identity, pageArgs(args));
    case 'createSupportLink':
      return createSupportLink(identity, args.input as CreateSupportLinkInput);
    case 'selectPrimaryUser':
      return selectPrimaryUser(identity, args.input as SelectPrimaryUserInput);
    case 'unselectPrimaryUser':
      return unselectPrimaryUser(identity, args.input as UnselectPrimaryUserInput);
    case 'listPrimaryUsersBySupporter':
      return listPrimaryUsersBySupporter(identity, args.supporterId as string, pageArgs(args));
    case 'listMySupportList':
      return listMySupportList(identity, pageArgs(args));
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

  const editable = {
    role,
    displayName,
    email,
    organizationId: input?.organizationId?.trim(),
    accessibilitySettings: input?.accessibilitySettings,
  };

  const existing = await getProfile(userId);

  // Profile already has a default — validate it, then overwrite only the editable fields
  // (carrying the existing task counters forward so a re-create never resets them).
  if (existing?.defaultCategoryId) {
    await assertValidDefaultCategory(userId, existing.defaultCategoryId);
    return putProfile(userId, editable, existing.defaultCategoryId, existing.createdAt, {
      taskCount: existing.taskCount,
      nextTaskOrder: existing.nextTaskOrder,
    });
  }

  // No valid default yet → create the default category alongside the profile, atomically.
  // A brand-new profile starts the per-owner task counters at 0 / 1.
  const defaultCategoryId = randomUUID();
  const now = new Date().toISOString();
  const profile = buildProfile(userId, editable, defaultCategoryId, existing?.createdAt ?? now, now, {
    taskCount: existing?.taskCount ?? 0,
    nextTaskOrder: existing?.nextTaskOrder ?? 1,
  });

  // Profile write: create-only when there is no profile yet; otherwise (a legacy profile
  // missing its default) set the default on the existing row, guarded so it's set once.
  const profileWrite = existing
    ? {
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(userId), SK: PROFILE_SK },
          UpdateExpression:
            'SET #role = :role, displayName = :displayName, email = :email, ' +
            'organizationId = :organizationId, accessibilitySettings = :accessibilitySettings, ' +
            'defaultCategoryId = :defaultCategoryId, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(defaultCategoryId)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: {
            ':role': editable.role,
            ':displayName': editable.displayName,
            ':email': editable.email ?? null,
            ':organizationId': editable.organizationId ?? null,
            ':accessibilitySettings': editable.accessibilitySettings ?? null,
            ':defaultCategoryId': defaultCategoryId,
            ':now': now,
          },
        },
      }
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

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
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
        ],
      }),
    );
    return profile;
  } catch (err) {
    // A concurrent first call already created the profile + default (or set the default on
    // a legacy row). Reread and reuse it rather than minting a second default category.
    if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;
    const reread = await getProfile(userId);
    if (!reread?.defaultCategoryId) throw err;
    await assertValidDefaultCategory(userId, reread.defaultCategoryId);
    return putProfile(userId, editable, reread.defaultCategoryId, reread.createdAt, {
      taskCount: reread.taskCount,
      nextTaskOrder: reread.nextTaskOrder,
    });
  }
}

/** Read the caller's profile row (undefined if it doesn't exist). */
async function getProfile(userId: string): Promise<UserProfile | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: PROFILE_SK } }),
  );
  return result.Item as UserProfile | undefined;
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
 * Overwrite the editable profile fields, preserving the existing default + createdAt + task
 * counters (a full Put replaces the item, so the counters must be re-supplied or they'd drop).
 */
async function putProfile(
  userId: string,
  editable: EditableProfile,
  defaultCategoryId: string,
  createdAt: string,
  counters: TaskCounters,
): Promise<UserProfile> {
  const profile = buildProfile(
    userId,
    editable,
    defaultCategoryId,
    createdAt,
    new Date().toISOString(),
    counters,
  );
  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: userPk(userId), SK: PROFILE_SK, entityType: ENTITY.USER_PROFILE, ...profile },
    }),
  );
  return profile;
}

/**
 * Verify a profile's stored `defaultCategoryId` points at a real row owned by the user with
 * `isDefault: true` and the reserved name. A missing/invalid pointer is a hard failure
 * (run the migration to repair) — we never silently create a duplicate default.
 */
async function assertValidDefaultCategory(userId: string, defaultCategoryId: string): Promise<void> {
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

  if (orgKeyPresent) {
    // MVP self-service org membership: explicit null clears it; a non-empty string sets it
    // (a blank/whitespace string is rejected — use null to clear). role/email/etc. stay locked.
    if (input.organizationId === null) {
      removeParts.push('organizationId');
    } else {
      const organizationId = input.organizationId?.trim();
      if (!organizationId) {
        throw new ValidationError('organizationId cannot be empty; use null to clear it');
      }
      setParts.push('organizationId = :organizationId');
      values[':organizationId'] = organizationId;
    }
  }

  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length) updateExpression += ` REMOVE ${removeParts.join(', ')}`;

  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: PROFILE_SK },
        UpdateExpression: updateExpression,
        // Never create a profile row — the update only applies to an existing one.
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripProfile(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`profile for user ${userId} not found`);
    }
    throw err;
  }
}

async function getUserProfile(userId: string): Promise<UserProfile | null> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: PROFILE_SK } }),
  );
  return (result.Item as UserProfile) ?? null;
}

/**
 * listUsersByOrganization — DEPRECATED, now strictly SELF-SCOPED. Prefer listMyOrganizationUsers.
 * The org argument is no longer trusted to enumerate an arbitrary roster: the caller may only
 * list THEIR OWN current organization. The supplied organizationId must equal the caller's
 * current org (else NOT_AUTHORIZED); a caller with no org gets a VALIDATION error. Returns the
 * lightweight orgIndex projection (userId, displayName, role).
 */
async function listUsersByOrganization(
  identity: AppSyncIdentity | undefined,
  organizationId: string,
  page: PageArgs,
): Promise<Connection<UserProfile>> {
  const requested = organizationId?.trim();
  if (!requested) throw new ValidationError('organizationId is required');
  const callerOrg = await requireCallerOrganization(identity);
  if (requested !== callerOrg) {
    throw new UnauthorizedError('Unauthorized: you can only list your own organization');
  }
  return queryOrgRoster(callerOrg, page);
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
      ExpressionAttributeValues: { ':org': organizationId },
    },
    page,
  );
}

// ── SupportLink selection (SupportPerson delegated access) ──────────────────────

/**
 * selectPrimaryUser — a SupportPerson selects a PRIMARY_USER in their OWN organization to
 * support, writing (or restoring) the SupportLink as ACTIVE. The supporter is ALWAYS the
 * authenticated caller (never client-supplied). Guard rails:
 *  - only a SupportPerson may select (a primary user cannot select a supporter);
 *  - the caller must currently belong to an organization;
 *  - the target must exist, be a PRIMARY_USER, and currently share the caller's organization.
 * The write is an idempotent upsert: a brand-new link is created ACTIVE, and a previously
 * REVOKED link is restored to ACTIVE while preserving its original createdAt.
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
  if (!supporterOrg) {
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

  const now = new Date().toISOString();
  // Upsert: create ACTIVE if absent, or restore a REVOKED link to ACTIVE — preserving its
  // original createdAt. supporterId/userId are (re)written so the GSIs stay populated.
  const setParts = [
    'entityType = :entityType',
    'supporterId = :supporterId',
    'primaryUserId = :primaryUserId',
    // `userId` mirrors primaryUserId — the supporterIndex / primaryUserSupportLinkIndex key.
    'userId = :primaryUserId',
    '#status = :active',
    'createdAt = if_not_exists(createdAt, :now)',
    'updatedAt = :now',
  ];
  const values: Record<string, unknown> = {
    ':entityType': ENTITY.SUPPORT_LINK,
    ':supporterId': supporterId,
    ':primaryUserId': primaryUserId,
    ':active': 'ACTIVE',
    ':now': now,
  };
  // Permissions: set only when supplied (omitted ⇒ leave any prior value untouched).
  if (input?.permissions !== undefined) {
    setParts.push('permissions = :permissions');
    values[':permissions'] = input.permissions ?? null;
  }

  const result = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) },
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return stripSupportLink(result.Attributes as Record<string, unknown>);
}

/**
 * unselectPrimaryUser — a SupportPerson un-selects a primary user, SOFT-revoking the SupportLink
 * (status REVOKED) rather than deleting it, so the original row (and createdAt) survives and a
 * later selectPrimaryUser restores it. The supporter is the authenticated caller; only a
 * SupportPerson may unselect. NotFound if no link exists for the (caller, primaryUser) pair.
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
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) },
        UpdateExpression: 'SET #status = :revoked, updatedAt = :now',
        // Never create a link here — only revoke one that exists.
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'REVOKED', ':now': now },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripSupportLink(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`no support link from ${supporterId} to ${primaryUserId} to unselect`);
    }
    throw err;
  }
}

/**
 * createSupportLink — DEPRECATED compatibility alias for selectPrimaryUser. The supporter is the
 * authenticated caller (the client-supplied supporterId is IGNORED — it must never be trusted),
 * and the same SupportPerson-only / same-organization / target-is-a-primary-user checks apply.
 * The client-supplied status is ignored too: the link is always (re)activated as ACTIVE.
 */
async function createSupportLink(
  identity: AppSyncIdentity | undefined,
  input: CreateSupportLinkInput,
): Promise<SupportLink> {
  return selectPrimaryUser(identity, {
    primaryUserId: input?.primaryUserId,
    permissions: input?.permissions,
  });
}

/**
 * listMySupportList — the AUTHENTICATED caller's own support list (every primary user they have
 * selected, ACTIVE and REVOKED), via supporterIndex keyed on the caller's sub.
 */
async function listMySupportList(
  identity: AppSyncIdentity | undefined,
  page: PageArgs,
): Promise<Connection<SupportLink>> {
  const supporterId = requireCaller(identity);
  return querySupportList(supporterId, page);
}

/**
 * listPrimaryUsersBySupporter — DEPRECATED alias for listMySupportList. Now strictly
 * self-scoped: a caller may only list their OWN support list, so the supplied supporterId must
 * equal the caller's sub (else NOT_AUTHORIZED) — a client can no longer read an arbitrary
 * supporter's links.
 */
async function listPrimaryUsersBySupporter(
  identity: AppSyncIdentity | undefined,
  supporterId: string,
  page: PageArgs,
): Promise<Connection<SupportLink>> {
  const caller = requireCaller(identity);
  const requested = supporterId?.trim();
  if (!requested) throw new ValidationError('supporterId is required');
  if (requested !== caller) {
    throw new UnauthorizedError('Unauthorized: you can only list your own support list');
  }
  return querySupportList(caller, page);
}

/** Query a supporter's SupportLinks (supporterIndex), shared by listMySupportList + the alias. */
function querySupportList(supporterId: string, page: PageArgs): Promise<Connection<SupportLink>> {
  return queryPage<SupportLink>(
    {
      TableName: TABLE_NAME,
      IndexName: SUPPORTER_INDEX,
      KeyConditionExpression: 'supporterId = :sup',
      ExpressionAttributeValues: { ':sup': supporterId },
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
