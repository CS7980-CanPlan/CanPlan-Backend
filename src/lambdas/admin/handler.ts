import {
  type AttributeType,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  assertNoActiveAssignmentsForTask,
  queryActiveAssignmentKeysForTask,
} from '../../shared/assignment';
import { requireGroup } from '../../shared/auth';
import { requireCaller } from '../../shared/authz';
import { batchDelete, type ItemKey, queryAllItems, queryAllKeys } from '../../shared/batch';
import {
  BASE_ROLE_GROUPS,
  BASE_ROLE_TO_GROUP,
  cognito,
  findCognitoUsernameBySub,
  listGroupsForUser,
  SYSTEM_ADMIN_GROUP,
  USER_POOL_ID,
} from '../../shared/cognito';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  CATEGORY_PREFIX,
  ENTITY,
  ENTITY_TYPE_INDEX,
  type EntityType,
  META_SK,
  ORG_MEMBER_PREFIX,
  organizationMemberSk,
  organizationPk,
  PRIMARY_USER_SUPPORT_LINK_INDEX,
  PROFILE_SK,
  supporterPk,
  TASK_ASSIGNMENT_PREFIX,
  TASK_OWNER_INDEX,
  USER_LINK_PREFIX,
  userPk,
} from '../../shared/keys';
import {
  assertUsableOrganization,
  getOrganization,
  isTransactConditionCheckFailure,
  organizationConditionCheck,
  organizationMemberDelete,
  organizationMemberPut,
  stripOrganization,
} from '../../shared/organization';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { deleteTaskCascade } from '../../shared/taskCascade';
import type {
  AdminDeleteOrganizationResult,
  AdminDeleteUserInput,
  AdminDeleteUserResult,
  AdminSetUserOrganizationInput,
  AdminUserData,
  AdminUserResult,
  AppSyncEvent,
  AppSyncIdentity,
  Category,
  Connection,
  CreateOrganizationInput,
  DeleteOrganizationInput,
  InviteUserInput,
  Organization,
  SetSystemAdminInput,
  SetUserBaseRoleInput,
  SupportLink,
  Task,
  TaskAssignment,
  UpdateOrganizationInput,
  UserProfile,
} from '../../shared/types';

/** Only SystemAdmins may call ANY admin API (read or write). */
const ADMIN_GROUP = SYSTEM_ADMIN_GROUP;

type AdminResult =
  | Connection<UserProfile>
  | Connection<Task>
  | Connection<Organization>
  | AdminUserResult
  | AdminUserData
  | AdminDeleteUserResult
  | AdminDeleteOrganizationResult
  | Organization
  | UserProfile
  | Task
  | null;

/**
 * Admin domain Lambda — SystemAdmin-only operations: the read-only entityTypeIndex listings
 * plus Cognito role management (invite, base-role, SystemAdmin toggle) and destructive data
 * APIs (delete any task, fully delete a user). Cognito group membership stays the source of
 * truth for authorization; these write APIs manage that membership and the data behind it.
 *
 * Every field is gated TWICE: at the AppSync edge via @aws_cognito_user_pools(cognito_groups:
 * ["SystemAdmin"]) AND re-checked here (defense-in-depth) before any routing, so a non-admin
 * never learns which fields exist or triggers any side effect.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<AdminResult> => {
  requireGroup(event.identity, ADMIN_GROUP);

  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    // ── Read-only listings (entityTypeIndex, no Scan) ──────────────────────────
    case 'listAllUsers':
      return listByEntityType<UserProfile>(ENTITY.USER_PROFILE, pageArgs(args));
    case 'listAllTasks':
      return listByEntityType<Task>(ENTITY.TASK, pageArgs(args));
    case 'adminGetUserData':
      return adminGetUserData(args.userId as string);
    case 'listAllOrganizations':
      return listByEntityType<Organization>(ENTITY.ORGANIZATION, pageArgs(args));
    case 'adminListOrganizationUsers':
      return adminListOrganizationUsers(args.organizationId as string, pageArgs(args));
    // ── Organization management ─────────────────────────────────────────────────
    case 'adminCreateOrganization':
      return adminCreateOrganization(args.input as CreateOrganizationInput);
    case 'adminUpdateOrganization':
      return adminUpdateOrganization(args.input as UpdateOrganizationInput);
    case 'adminDeleteOrganization':
      return adminDeleteOrganization(args.input as DeleteOrganizationInput);
    case 'adminSetUserOrganization':
      return adminSetUserOrganization(args.input as AdminSetUserOrganizationInput);
    // ── Cognito role management ─────────────────────────────────────────────────
    case 'inviteSupportPerson':
      return inviteUser(args.input as InviteUserInput, BASE_ROLE_TO_GROUP.SUPPORT_PERSON);
    case 'inviteOrganizationAdmin':
      return inviteUser(args.input as InviteUserInput, BASE_ROLE_TO_GROUP.ORG_ADMIN);
    case 'setUserBaseRole':
      return setUserBaseRole(args.input as SetUserBaseRoleInput);
    case 'setSystemAdmin':
      return setSystemAdmin(identity, args.input as SetSystemAdminInput);
    // ── Destructive data APIs ───────────────────────────────────────────────────
    case 'adminDeleteTask':
      return adminDeleteTask(args.taskId as string);
    case 'adminDeleteUser':
      return adminDeleteUser(identity, args.input as AdminDeleteUserInput);
    default:
      throw new Error(`admin handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/** Query entityTypeIndex for one entityType, newest-first, with opaque-token pagination. */
function listByEntityType<T>(entityType: EntityType, page: PageArgs): Promise<Connection<T>> {
  return queryPage<T>(
    {
      TableName: TABLE_NAME,
      IndexName: ENTITY_TYPE_INDEX,
      KeyConditionExpression: 'entityType = :et',
      ExpressionAttributeValues: { ':et': entityType },
      ScanIndexForward: false, // newest createdAt first
    },
    page,
  );
}

/**
 * Aggregate everything one user owns, for the SystemAdmin user-detail view. Gathers the
 * profile, owned tasks (taskOwnerIndex), categories + task assignments (the USER#<id>
 * partition), and support links in BOTH directions — all with PK queries + GSIs, never a
 * Scan. Each collection is read in full (no pagination); a single user's footprint is bounded
 * and this mirrors what adminDeleteUser already traverses. Internal storage attributes
 * (PK/SK/etc.) on the items are simply not selected by the GraphQL type, so they are not returned.
 */
async function adminGetUserData(userId: string): Promise<AdminUserData> {
  const id = userId?.trim();
  if (!id) throw new ValidationError('userId is required and cannot be empty');

  const [profile, tasks, categories, taskAssignments, supportLinks] = await Promise.all([
    readProfile(id),
    queryAllOwnedTasks(id),
    queryAllItems<Category>(userPk(id), CATEGORY_PREFIX),
    queryAllItems<TaskAssignment>(userPk(id), TASK_ASSIGNMENT_PREFIX),
    gatherSupportLinks(id),
  ]);

  return { userId: id, profile, tasks, categories, taskAssignments, supportLinks };
}

/**
 * All SupportLinks touching a user — both where they are the supporter (SUPPORTER#<id>
 * partition) and where they are the primary user (primaryUserSupportLinkIndex). Deduped by
 * the supporter/primary pair in case a row qualifies under both reads.
 */
async function gatherSupportLinks(userId: string): Promise<SupportLink[]> {
  const [asSupporter, asPrimary] = await Promise.all([
    queryAllItems<SupportLink>(supporterPk(userId), USER_LINK_PREFIX),
    queryAllPrimaryUserSupportLinks(userId),
  ]);
  const seen = new Set<string>();
  const links: SupportLink[] = [];
  for (const link of [...asSupporter, ...asPrimary]) {
    const key = `${link.supporterId}|${link.primaryUserId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}

/** Full SupportLink items where the target user is the PRIMARY user (primaryUserSupportLinkIndex). */
async function queryAllPrimaryUserSupportLinks(userId: string): Promise<SupportLink[]> {
  const items: SupportLink[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: PRIMARY_USER_SUPPORT_LINK_INDEX,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((result.Items as SupportLink[]) ?? []));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

// ── Organization management ───────────────────────────────────────────────────────

/**
 * Create an Organization. `name` is required (trimmed, non-empty); the id is server-generated.
 * The Put is guarded by attribute_not_exists(PK) so a UUID collision can never overwrite a row.
 * Returns the Organization without internal storage attributes.
 */
async function adminCreateOrganization(input: CreateOrganizationInput): Promise<Organization> {
  const name = input?.name?.trim();
  if (!name) throw new ValidationError('name is required and cannot be empty');

  const organizationId = randomUUID();
  const now = new Date().toISOString();
  const organization: Organization = { organizationId, name, createdAt: now, updatedAt: now };
  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: organizationPk(organizationId),
        SK: META_SK,
        entityType: ENTITY.ORGANIZATION,
        ...organization,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return organization;
}

/**
 * Rename an Organization. A pre-read (assertUsableOrganization) gives clear errors — NotFound
 * for a missing org, ValidationError for one mid-deletion — and the conditional update guards
 * against a concurrent delete racing between the read and the write (mapped to NotFound).
 */
async function adminUpdateOrganization(input: UpdateOrganizationInput): Promise<Organization> {
  const organizationId = input?.organizationId?.trim();
  if (!organizationId) throw new ValidationError('organizationId is required and cannot be empty');
  const name = input?.name?.trim();
  if (!name) throw new ValidationError('name is required and cannot be empty');

  await assertUsableOrganization(organizationId);

  const now = new Date().toISOString();
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: organizationPk(organizationId), SK: META_SK },
        UpdateExpression: 'SET #name = :name, updatedAt = :now',
        // `name` is a DynamoDB reserved word — alias it. Re-assert existence + not-deleting.
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deleting)',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: { ':name': name, ':now': now },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripOrganization(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`organization ${organizationId} not found`);
    }
    throw err;
  }
}

/**
 * Delete an Organization, detaching every member first. Order: (1) load the org (NotFound if
 * gone); (2) mark it `deleting` so no new membership can join mid-removal; (3) detach every member
 * found via the STRONGLY-CONSISTENT OrganizationMember rows under the org partition (a consistent
 * Query, paginated, never a Scan) — each member is its own transaction that clears the profile's
 * organizationId and deletes the membership row together; (4) delete the org #META row LAST.
 *
 * Membership rows (not the eventually-consistent orgIndex) are the source of truth here: a user
 * who joined moments before step 2 is guaranteed visible to a consistent read of the org
 * partition, so this can never miss a member and leave their profile pointing at a deleted org.
 * Idempotent/retryable: re-marking an already-`deleting` org is harmless and a retry resumes from
 * whatever membership rows remain.
 */
async function adminDeleteOrganization(
  input: DeleteOrganizationInput,
): Promise<AdminDeleteOrganizationResult> {
  const organizationId = input?.organizationId?.trim();
  if (!organizationId) throw new ValidationError('organizationId is required and cannot be empty');

  const existing = await getOrganization(organizationId);
  if (!existing) throw new NotFoundError(`organization ${organizationId} not found`);

  // 1) Mark deleting (idempotent — fine if already set on a retry).
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: organizationPk(organizationId), SK: META_SK },
      UpdateExpression: 'SET deleting = :true, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
    }),
  );

  // 2) Detach every member (strongly-consistent membership rows, paginated).
  const removedUsers = await detachOrganizationMembers(organizationId);

  // 3) Remove the org row only after members are detached.
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: organizationPk(organizationId), SK: META_SK },
    }),
  );

  return { organization: stripOrganization(existing), removedUsers };
}

/**
 * Detach every member of `organizationId`, found via the OrganizationMember rows under the org
 * partition (PK = ORG#<id>, SK begins_with MEMBER#) read with ConsistentRead so a just-joined
 * member is never missed. The base-table Query is followed to completion (no Scan) and each member
 * is detached in its own transaction. Returns how many member profiles were actually detached in
 * this run (stale rows whose profile had already moved are cleaned up but not counted).
 */
async function detachOrganizationMembers(organizationId: string): Promise<number> {
  let removed = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :member)',
        ExpressionAttributeValues: {
          ':pk': organizationPk(organizationId),
          ':member': ORG_MEMBER_PREFIX,
        },
        // Strongly consistent: a member who joined just before the org was marked deleting must be
        // visible here — the eventually-consistent orgIndex GSI could miss them (the bug we fix).
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const member of (result.Items as Array<{ userId: string }>) ?? []) {
      if (await detachOrganizationMember(organizationId, member.userId)) removed += 1;
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return removed;
}

/**
 * Detach ONE member in a single transaction: conditionally REMOVE organizationId from their
 * UserProfile (only while it still equals this org) AND delete the OrganizationMember row, so
 * profile and membership cleanup stay together. Returns true when the profile was detached.
 *
 * If the member had already moved to a different org, the conditional profile update fails and
 * cancels the transaction; the membership row is now stale, so delete it on its own (leaving the
 * moved profile untouched) and return false — this keeps org deletion able to complete and remain
 * idempotent on retry.
 */
async function detachOrganizationMember(organizationId: string, userId: string): Promise<boolean> {
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(userId), SK: PROFILE_SK },
              UpdateExpression: 'SET updatedAt = :now REMOVE organizationId',
              ConditionExpression: 'organizationId = :org',
              ExpressionAttributeValues: { ':org': organizationId, ':now': new Date().toISOString() },
            },
          },
          organizationMemberDelete(organizationId, userId),
        ],
      }),
    );
    return true;
  } catch (err) {
    // ONLY transact-item 0 (the profile update's `organizationId = :org` guard) failing means the
    // member moved/gone and the membership row is stale — then drop it alone so deletion completes.
    // Any OTHER cancellation (TransactionConflict, throttling, …) is transient: rethrow so a retry
    // re-attempts the whole detach. Silently deleting the row here would orphan a profile that still
    // points at this org (the row would be gone, so no retry could ever find that member again).
    if (!isTransactConditionCheckFailure(err, 0)) throw err;
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: organizationPk(organizationId), SK: organizationMemberSk(userId) },
      }),
    );
    return false;
  }
}

/**
 * The roster of ONE organization's members, for the admin org-detail view. Pages the
 * strongly-consistent OrganizationMember rows under the org partition (PK = ORG#<id>, SK
 * begins_with MEMBER#) — a base-table Query, never a Scan — then loads each member's UserProfile.
 * A membership row whose profile is missing (a rare inconsistency) is skipped rather than crashing.
 * Pagination is on the membership rows: `nextToken` advances the row page, so a page can return
 * fewer profiles than the limit when some are skipped, but never loses its place.
 */
async function adminListOrganizationUsers(
  organizationId: string,
  page: PageArgs,
): Promise<Connection<UserProfile>> {
  const id = organizationId?.trim();
  if (!id) throw new ValidationError('organizationId is required and cannot be empty');

  const memberPage = await queryPage<{ userId: string }>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :member)',
      ExpressionAttributeValues: { ':pk': organizationPk(id), ':member': ORG_MEMBER_PREFIX },
      // Strongly consistent so the admin UI reflects a just-added/removed member immediately (it
      // typically refetches right after adminSetUserOrganization) rather than a stale GSI-like view.
      ConsistentRead: true,
    },
    page,
  );

  const profiles = await Promise.all(memberPage.items.map((m) => readProfile(m.userId)));
  const items = profiles.filter((p): p is UserProfile => p !== null);
  return { items, nextToken: memberPage.nextToken };
}

/**
 * Set or clear ANOTHER user's organization membership (SystemAdmin-only; updateMyUserProfile is
 * self-only). Reads the target profile first (NotFound if none) to learn its previous org, then in
 * ONE transaction keeps the UserProfile.organizationId and the OrganizationMember rows in step:
 *  - joining a non-null org: verify it exists + isn't deleting (a pre-read for a clear error, plus a
 *    ConditionCheck in the transaction to close the race), set organizationId, put the new membership
 *    row, and delete the old org's row when moving;
 *  - clearing (null): remove organizationId and delete the old membership row.
 * TransactWrite returns no attributes, so the updated profile is read back and returned.
 */
async function adminSetUserOrganization(
  input: AdminSetUserOrganizationInput,
): Promise<UserProfile> {
  const userId = input?.userId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');

  // organizationId MUST be present: a non-null value sets it (blank rejected), explicit null clears
  // it. Omitting the field is rejected so a client that forgets to pass the variable can't silently
  // wipe a user's organization.
  const raw = input?.organizationId;
  if (raw === undefined) {
    throw new ValidationError(
      'organizationId is required: pass an id to set the organization, or null to clear it',
    );
  }
  let newOrg: string | undefined;
  if (raw !== null) {
    newOrg = raw.trim();
    if (!newOrg) throw new ValidationError('organizationId cannot be blank; pass null to clear it');
  }

  const existing = await readProfile(userId);
  if (!existing) throw new NotFoundError(`user ${userId} not found`);
  const previousOrg = existing.organizationId?.trim() || undefined;

  const now = new Date().toISOString();
  const profileKey = { PK: userPk(userId), SK: PROFILE_SK };
  // Bind the profile write to the org state seen at pre-read (item 0 of every path below). If a
  // concurrent request moves/clears the user's org in between, this condition fails and cancels the
  // write instead of deleting a now-stale membership row (which would orphan the row for the org the
  // profile was concurrently moved to).
  const guard = profileOrgGuard(previousOrg);

  if (newOrg) {
    // Clear pre-read error (NotFound / being-deleted), then the same check rides the transaction.
    await assertUsableOrganization(newOrg);
    const transactItems: Array<Record<string, unknown>> = [
      {
        Update: {
          TableName: TABLE_NAME,
          Key: profileKey,
          UpdateExpression: 'SET organizationId = :org, updatedAt = :now',
          ConditionExpression: guard.ConditionExpression,
          ExpressionAttributeValues: { ':org': newOrg, ':now': now, ...guard.values },
        },
      },
      organizationConditionCheck(newOrg),
      organizationMemberPut(newOrg, userId),
    ];
    if (previousOrg && previousOrg !== newOrg) {
      transactItems.push(organizationMemberDelete(previousOrg, userId));
    }
    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      // Item 1 = org ConditionCheck (target org vanished); item 0 = profile guard (the user was
      // moved/removed since the pre-read). Anything else (e.g. TransactionConflict) is rethrown.
      if (isTransactConditionCheckFailure(err, 1)) {
        throw new ValidationError(
          `organization ${newOrg} is no longer available (it was deleted or is being deleted)`,
        );
      }
      if (isTransactConditionCheckFailure(err, 0)) throw profileOrgConflictError(userId);
      throw err;
    }
    return readBackProfile(userId);
  }

  // Clearing with a current org: remove organizationId and drop that membership row in one
  // transaction, guarded so a concurrent move can't leave the new org's membership row orphaned.
  if (previousOrg) {
    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE_NAME,
                Key: profileKey,
                UpdateExpression: 'SET updatedAt = :now REMOVE organizationId',
                ConditionExpression: guard.ConditionExpression,
                ExpressionAttributeValues: { ':now': now, ...guard.values },
              },
            },
            organizationMemberDelete(previousOrg, userId),
          ],
        }),
      );
    } catch (err) {
      if (isTransactConditionCheckFailure(err, 0)) throw profileOrgConflictError(userId);
      throw err;
    }
    return readBackProfile(userId);
  }

  // Clearing when the profile had no org: a plain conditional REMOVE, guarded so a concurrent add
  // (which would have created a membership row) can't be silently wiped without dropping that row.
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: profileKey,
        UpdateExpression: 'SET updatedAt = :now REMOVE organizationId',
        ConditionExpression: guard.ConditionExpression,
        ExpressionAttributeValues: { ':now': now, ...guard.values },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw profileOrgConflictError(userId);
    }
    throw err;
  }
  return readBackProfile(userId);
}

/**
 * A conditional guard binding a UserProfile write to the org it had at pre-read: it had a specific
 * org (`organizationId = :prevOrg`) or none (`attribute_not_exists(organizationId)`). Included on
 * every adminSetUserOrganization write so a concurrent org change cancels the write rather than
 * letting it delete a stale membership row and orphan the concurrently-set org's row.
 */
function profileOrgGuard(previousOrg: string | undefined): {
  ConditionExpression: string;
  values: Record<string, unknown>;
} {
  return previousOrg
    ? {
        ConditionExpression: 'attribute_exists(PK) AND organizationId = :prevOrg',
        values: { ':prevOrg': previousOrg },
      }
    : {
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(organizationId)',
        values: {},
      };
}

/**
 * The target profile's org changed (or the profile was removed) between the pre-read and the write,
 * so the operation was aborted rather than risk orphaning a membership row. Retrying re-reads the
 * now-current state and applies the change to it.
 */
function profileOrgConflictError(userId: string): ValidationError {
  return new ValidationError(
    `user ${userId}'s organization changed concurrently (they were moved to a different ` +
      'organization, or their profile was removed); re-read and retry',
  );
}

/** Read a UserProfile back after a TransactWrite (which returns no attributes); NotFound if gone. */
async function readBackProfile(userId: string): Promise<UserProfile> {
  const updated = await readProfile(userId);
  if (!updated) throw new NotFoundError(`user ${userId} not found`);
  return updated;
}

// ── Cognito role management ──────────────────────────────────────────────────────

/**
 * Create (or adopt an existing) Cognito user and add EXACTLY ONE base group — never
 * PrimaryUser, which is reserved for self-signup. If the user already exists,
 * UsernameExistsException is handled by looking the user up and applying the group anyway
 * (idempotent). No UserProfile is created — the app creates that via createUserProfile after
 * the invitee first logs in. Returns the user's id/sub, email, current groups, and profile if one
 * already exists.
 */
async function inviteUser(input: InviteUserInput, group: string): Promise<AdminUserResult> {
  const email = input?.email?.trim();
  if (!email) throw new ValidationError('email is required and cannot be empty');
  const displayName = input?.displayName?.trim();

  let username: string;
  try {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        // Email-alias pool: the Username is the email; Cognito mints the immutable `sub`.
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          ...(displayName ? [{ Name: 'name', Value: displayName }] : []),
        ],
        DesiredDeliveryMediums: ['EMAIL'], // emails the invitee a temporary password
      }),
    );
    if (!created.User?.Username) throw new Error('AdminCreateUser returned no Username');
    username = created.User.Username;
  } catch (err) {
    if ((err as { name?: string }).name !== 'UsernameExistsException') throw err;
    // Already a Cognito user — adopt it and just apply the correct group.
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email }),
    );
    if (!existing.Username) throw new Error(`existing Cognito user for ${email} has no Username`);
    username = existing.Username;
  }

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: group,
    }),
  );
  return buildUserResult(username);
}

/**
 * Set a user's single base role: remove them from ALL base groups (PrimaryUser/SupportPerson/
 * OrganizationAdmin — removing a non-member is a harmless no-op) then add the one target group.
 * SystemAdmin membership is untouched. If the user already has a UserProfile, its `role` is
 * mirrored to match (AdminBaseRole values equal UserRole values); a missing profile is left
 * alone — never created here.
 */
async function setUserBaseRole(input: SetUserBaseRoleInput): Promise<AdminUserResult> {
  const userId = input?.userId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  const role = input?.role;
  const targetGroup = role ? BASE_ROLE_TO_GROUP[role] : undefined;
  if (!targetGroup) {
    throw new ValidationError(`role must be one of ${Object.keys(BASE_ROLE_TO_GROUP).join(', ')}`);
  }

  const username = await requireUsername(userId);
  for (const baseGroup of BASE_ROLE_GROUPS) {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: baseGroup,
      }),
    );
  }
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: targetGroup,
    }),
  );

  await updateProfileRoleIfExists(userId, role);
  return buildUserResult(username);
}

/**
 * Grant or revoke the elevated SystemAdmin group. Base-role groups are never touched.
 * Self-demotion (a caller removing SystemAdmin from themselves) is rejected outright so an
 * admin can't lock themselves — possibly the last admin — out; granting to oneself is allowed.
 */
async function setSystemAdmin(
  identity: AppSyncIdentity | undefined,
  input: SetSystemAdminInput,
): Promise<AdminUserResult> {
  const userId = input?.userId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (typeof input?.enabled !== 'boolean') {
    throw new ValidationError('enabled is required and must be a boolean');
  }
  const callerSub = requireCaller(identity);
  if (!input.enabled && userId === callerSub) {
    throw new ValidationError(
      'cannot remove SystemAdmin from yourself; have another SystemAdmin do it',
    );
  }

  const username = await requireUsername(userId);
  await cognito.send(
    input.enabled
      ? new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: SYSTEM_ADMIN_GROUP,
        })
      : new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: SYSTEM_ADMIN_GROUP,
        }),
  );
  return buildUserResult(username);
}

// ── Destructive data APIs ────────────────────────────────────────────────────────

/** Delete ANY task regardless of owner via the shared cascade. Idempotent (null if gone). */
async function adminDeleteTask(taskId: string): Promise<Task | null> {
  const id = taskId?.trim();
  if (!id) throw new ValidationError('taskId is required and cannot be empty');
  // Same guard as the owner deleteTask: refuse while an active TaskAssignment references it.
  await assertNoActiveAssignmentsForTask(id);
  return deleteTaskCascade(id);
}

/**
 * Fully delete a user: all owned tasks (cascade), every row in their USER# partition, all
 * SupportLinks naming them as supporter or primary user, and finally the Cognito login —
 * always LAST, so a DynamoDB/S3 failure (which throws) aborts before the login is removed and
 * leaves the operation safely retryable. Uses PK queries + GSIs only (never a Scan). Deleting
 * oneself is rejected.
 */
async function adminDeleteUser(
  identity: AppSyncIdentity | undefined,
  input: AdminDeleteUserInput,
): Promise<AdminDeleteUserResult> {
  const userId = input?.userId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  const callerSub = requireCaller(identity);
  if (userId === callerSub) throw new ValidationError('cannot delete yourself');

  const deleteCognitoUser = input.deleteCognitoUser ?? true;
  const disableFirst = input.disableFirst ?? true;

  // Resolve the Cognito username up front — may already be missing (treated as success later).
  const username = await findCognitoUsernameBySub(USER_POOL_ID, userId);

  // Disable before deleting data so an in-flight session can't race the cleanup.
  if (deleteCognitoUser && disableFirst && username) {
    await cognito.send(
      new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
    );
  }

  // 1) Every task owned by the user (taskOwnerIndex, entityType=Task) — full cascade each.
  //    Owner deleteTask is normally rejected while an active TaskAssignment references the
  //    task, but full user deletion bypasses that guard. A task this user owns may be assigned
  //    to ANOTHER user (whose partition is NOT deleted here), so first remove every active
  //    TaskAssignment referencing these tasks — otherwise it would dangle, pointing at a
  //    now-missing template.
  const ownedTasks = await queryAllOwnedTasks(userId);
  const orphanedAssignmentKeys: ItemKey[] = [];
  for (const task of ownedTasks) {
    orphanedAssignmentKeys.push(...(await queryActiveAssignmentKeysForTask(task.taskId)));
  }
  await batchDelete(orphanedAssignmentKeys);
  for (const task of ownedTasks) {
    await deleteTaskCascade(task.taskId, { task });
  }

  // 2) Delete the UserProfile row and its OrganizationMember row atomically. The membership row
  //    lives under ORG#<org>, so a USER# partition batch cannot catch it. Deleting both in one
  //    TransactWrite avoids both bad partial states:
  //      - profile gone, membership row still present (retry cannot rediscover the org);
  //      - membership row gone, profile still pointing at the org (org deletion could miss it).
  const profile = await readProfile(userId);
  const memberOrgId = profile?.organizationId?.trim() || undefined;
  const userRows = await queryAllKeys(userPk(userId));
  const profileKeyInUserRows = userRows.some((row) => row.SK === PROFILE_SK);
  if (profile || profileKeyInUserRows) {
    await deleteProfileAndMembership(userId, memberOrgId);
  }

  // 3) Delete the remaining USER# partition rows (Category, TaskAssignment, TaskInstance,
  //    TaskInstanceStep, …). The profile was handled transactionally above.
  const remainingUserRows = userRows.filter((row) => row.SK !== PROFILE_SK);
  await batchDelete(remainingUserRows);

  // 4) SupportLinks where the user is the SUPPORTER (PK = SUPPORTER#<userId>) and …
  const supporterRows = await queryAllKeys(supporterPk(userId));
  // 5) … where the user is the PRIMARY user (primaryUserSupportLinkIndex, userId = target).
  const primaryLinkKeys = await queryPrimaryUserSupportLinkKeys(userId);
  await batchDelete([...supporterRows, ...primaryLinkKeys]);

  // 6) Cognito user LAST — only after all data cleanup above succeeded.
  let deletedCognitoUser = false;
  if (deleteCognitoUser) {
    if (username) {
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
      );
    }
    // A missing login (already gone) is success now that the data is cleaned up.
    deletedCognitoUser = true;
  }

  return {
    userId,
    deletedTasks: ownedTasks.length,
    deletedUserItems: userRows.length,
    deletedSupportLinks: supporterRows.length + primaryLinkKeys.length,
    deletedCognitoUser,
  };
}

/**
 * Delete the profile and its org-membership mirror together. The profile condition makes the
 * pre-read race-safe: if the user joins/moves orgs between readProfile and this transaction, abort
 * so a retry can read the new org and delete the correct OrganizationMember row.
 */
async function deleteProfileAndMembership(
  userId: string,
  organizationId: string | undefined,
): Promise<void> {
  const profileDelete = organizationId
    ? {
        Delete: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(userId), SK: PROFILE_SK },
          ConditionExpression: 'attribute_not_exists(PK) OR organizationId = :org',
          ExpressionAttributeValues: { ':org': organizationId },
        },
      }
    : {
        Delete: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(userId), SK: PROFILE_SK },
          ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(organizationId)',
        },
      };

  const transactItems: Array<Record<string, unknown>> = [profileDelete];
  if (organizationId) transactItems.push(organizationMemberDelete(organizationId, userId));
  await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Resolve a Cognito Username for an app userId (sub), or NotFound if no such user exists. */
async function requireUsername(sub: string): Promise<string> {
  const username = await findCognitoUsernameBySub(USER_POOL_ID, sub);
  if (!username) throw new NotFoundError(`no Cognito user found for userId ${sub}`);
  return username;
}

/** Build the AdminUserResult for a Cognito Username: sub, email, current groups, profile. */
async function buildUserResult(username: string): Promise<AdminUserResult> {
  const user = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
  );
  const sub = attrValue(user.UserAttributes, 'sub');
  if (!sub) throw new Error(`Cognito user ${username} has no sub attribute`);
  return {
    userId: sub,
    email: attrValue(user.UserAttributes, 'email'),
    groups: await listGroupsForUser(USER_POOL_ID, username),
    profile: await readProfile(sub),
  };
}

/** Find a Cognito attribute value by name. */
function attrValue(attrs: AttributeType[] | undefined, name: string): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

/** Read a user's UserProfile (internal storage attributes stripped), or null if absent. */
async function readProfile(userId: string): Promise<UserProfile | null> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: PROFILE_SK },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) return null;
  delete item.PK;
  delete item.SK;
  delete item.entityType;
  return item as unknown as UserProfile;
}

/**
 * Mirror a base role onto an EXISTING UserProfile.role (no-op when the profile is absent —
 * never creates one). AdminBaseRole values equal the UserRole projection values.
 */
async function updateProfileRoleIfExists(userId: string, role: string): Promise<void> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: PROFILE_SK },
        UpdateExpression: 'SET #role = :role, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': role, ':now': new Date().toISOString() },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

/** Every Task #META owned by a user (taskOwnerIndex; entityType filters out MediaAsset rows). */
async function queryAllOwnedTasks(userId: string): Promise<Task[]> {
  const tasks: Task[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: TASK_OWNER_INDEX,
        KeyConditionExpression: 'ownerId = :owner',
        FilterExpression: 'entityType = :task',
        ExpressionAttributeValues: { ':owner': userId, ':task': ENTITY.TASK },
        ExclusiveStartKey: startKey,
      }),
    );
    tasks.push(...((result.Items as Task[]) ?? []));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return tasks;
}

/** SupportLink keys where the target user is the PRIMARY user (primaryUserSupportLinkIndex). */
async function queryPrimaryUserSupportLinkKeys(userId: string): Promise<ItemKey[]> {
  const keys: ItemKey[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: PRIMARY_USER_SUPPORT_LINK_INDEX,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (result.Items as ItemKey[]) ?? []) keys.push({ PK: item.PK, SK: item.SK });
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return keys;
}
