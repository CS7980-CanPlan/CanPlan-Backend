import {
  type AttributeType,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  ASSIGN_PREFIX,
  CATEGORY_PREFIX,
  ENTITY,
  ENTITY_TYPE_INDEX,
  type EntityType,
  PRIMARY_USER_SUPPORT_LINK_INDEX,
  PROFILE_SK,
  supporterPk,
  TASK_OWNER_INDEX,
  USER_LINK_PREFIX,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { deleteTaskCascade } from '../../shared/taskCascade';
import type {
  AdminDeleteUserInput,
  AdminDeleteUserResult,
  AdminUserData,
  AdminUserResult,
  AppSyncEvent,
  AppSyncIdentity,
  Assignment,
  Category,
  Connection,
  InviteUserInput,
  SetSystemAdminInput,
  SetUserBaseRoleInput,
  SupportLink,
  Task,
  UserProfile,
} from '../../shared/types';

/** Only SystemAdmins may call ANY admin API (read or write). */
const ADMIN_GROUP = SYSTEM_ADMIN_GROUP;

type AdminResult =
  | Connection<UserProfile>
  | Connection<Task>
  | AdminUserResult
  | AdminUserData
  | AdminDeleteUserResult
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
 * profile, owned tasks (taskOwnerIndex), categories + assignments (the USER#<id> partition),
 * and support links in BOTH directions — all with PK queries + GSIs, never a Scan. Each
 * collection is read in full (no pagination); a single user's footprint is bounded and this
 * mirrors what adminDeleteUser already traverses. Internal storage attributes (PK/SK/etc.)
 * on the items are simply not selected by the GraphQL type, so they are not returned.
 */
async function adminGetUserData(userId: string): Promise<AdminUserData> {
  const id = userId?.trim();
  if (!id) throw new ValidationError('userId is required and cannot be empty');

  const [profile, tasks, categories, assignments, supportLinks] = await Promise.all([
    readProfile(id),
    queryAllOwnedTasks(id),
    queryAllItems<Category>(userPk(id), CATEGORY_PREFIX),
    queryAllItems<Assignment>(userPk(id), ASSIGN_PREFIX),
    gatherSupportLinks(id),
  ]);

  return { userId: id, profile, tasks, categories, assignments, supportLinks };
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
  const ownedTasks = await queryAllOwnedTasks(userId);
  for (const task of ownedTasks) {
    await deleteTaskCascade(task.taskId, { task });
  }

  // 2) Every row in the user's own partition (UserProfile, Category, Assignment,
  //    AssignmentStep, ProgressEvent, …) — one PK query, no Scan.
  const userRows = await queryAllKeys(userPk(userId));
  await batchDelete(userRows);

  // 3) SupportLinks where the user is the SUPPORTER (PK = SUPPORTER#<userId>) and …
  const supporterRows = await queryAllKeys(supporterPk(userId));
  // 4) … where the user is the PRIMARY user (primaryUserSupportLinkIndex, userId = target).
  const primaryLinkKeys = await queryPrimaryUserSupportLinkKeys(userId);
  await batchDelete([...supporterRows, ...primaryLinkKeys]);

  // 5) Cognito user LAST — only after all data cleanup above succeeded.
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
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: PROFILE_SK } }),
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
