import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireCaller } from '../../shared/authz';
import { getOwnedCategory } from '../../shared/category';
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
import { NotFoundError, ValidationError } from '../../shared/response';
import { roleFromIdentity } from '../../shared/roles';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Category,
  Connection,
  CreateMyUserProfileInput,
  CreateSupportLinkInput,
  SupportLink,
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
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createUserProfile':
      return createMyUserProfile(event.identity, args.input as CreateMyUserProfileInput);
    case 'updateMyUserProfile':
      return updateMyUserProfile(event.identity, args.input as UpdateMyUserProfileInput);
    case 'getUserProfile':
      return getUserProfile(args.userId as string);
    case 'listUsersByOrganization':
      return listUsersByOrganization(args.organizationId as string, pageArgs(args));
    case 'createSupportLink':
      return createSupportLink(args.input as CreateSupportLinkInput);
    case 'listPrimaryUsersBySupporter':
      return listPrimaryUsersBySupporter(args.supporterId as string, pageArgs(args));
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
  // (carrying the existing task counters through untouched).
  if (existing?.defaultCategoryId) {
    await assertValidDefaultCategory(userId, existing.defaultCategoryId);
    return putProfile(userId, editable, existing.defaultCategoryId, existing.createdAt, existing);
  }

  // No valid default yet → create the default category alongside the profile, atomically.
  const defaultCategoryId = randomUUID();
  const now = new Date().toISOString();
  // A brand-new profile starts with zero tasks and the first order at 1; a legacy profile
  // that merely lacks a default keeps whatever counters it already has (the migration
  // backfills any that are still missing).
  const counters: ProfileCounters = existing
    ? { taskCount: existing.taskCount, nextTaskOrder: existing.nextTaskOrder }
    : { taskCount: 0, nextTaskOrder: 1 };
  const profile = buildProfile(userId, editable, defaultCategoryId, existing?.createdAt ?? now, now, counters);

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
    return putProfile(userId, editable, reread.defaultCategoryId, reread.createdAt, reread);
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

/** Owner-level task counters carried through a profile rewrite (never reset by an edit). */
type ProfileCounters = Pick<UserProfile, 'taskCount' | 'nextTaskOrder'>;

function buildProfile(
  userId: string,
  editable: EditableProfile,
  defaultCategoryId: string,
  createdAt: string,
  updatedAt: string,
  counters: ProfileCounters = {},
): UserProfile {
  return {
    userId,
    ...editable,
    defaultCategoryId,
    taskCount: counters.taskCount,
    nextTaskOrder: counters.nextTaskOrder,
    createdAt,
    updatedAt,
  };
}

/**
 * Overwrite the editable profile fields, preserving the existing default + createdAt AND the
 * owner's task counters (taskCount/nextTaskOrder) — a profile rewrite must never reset them,
 * or createTask would reuse `order` values and miscount the cap.
 */
async function putProfile(
  userId: string,
  editable: EditableProfile,
  defaultCategoryId: string,
  createdAt: string,
  counters: ProfileCounters = {},
): Promise<UserProfile> {
  const profile = buildProfile(userId, editable, defaultCategoryId, createdAt, new Date().toISOString(), counters);
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
 * touches role/email/organizationId/defaultCategoryId/createdAt/keys/entityType, and is a
 * targeted UpdateCommand (not a full-item Put) so every untouched field is preserved. Only
 * `displayName` and `accessibilitySettings` are editable:
 *  - `displayName`: omitted ⇒ unchanged; otherwise trimmed (null/empty/whitespace rejected).
 *  - `accessibilitySettings`: omitted ⇒ unchanged; explicit `null` ⇒ cleared (REMOVE); a
 *    non-null value ⇒ FULL replacement of the stored value (never deep-merged). It arrives
 *    already parsed from the AWSJSON argument and is stored as-is; AppSync re-serializes it
 *    to an AWSJSON string on the way out.
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
  if (!displayNameKeyPresent && !settingsKeyPresent) {
    throw new ValidationError(
      'at least one of displayName or accessibilitySettings must be supplied',
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

async function listUsersByOrganization(
  organizationId: string,
  page: PageArgs,
): Promise<Connection<UserProfile>> {
  if (!organizationId?.trim()) throw new ValidationError('organizationId is required');
  // orgIndex projects displayName + role — a lightweight roster, not the full profile.
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

async function createSupportLink(input: CreateSupportLinkInput): Promise<SupportLink> {
  const supporterId = input?.supporterId?.trim();
  const primaryUserId = input?.primaryUserId?.trim();
  if (!supporterId) throw new ValidationError('supporterId is required and cannot be empty');
  if (!primaryUserId) throw new ValidationError('primaryUserId is required and cannot be empty');

  const now = new Date().toISOString();
  const link: SupportLink = {
    supporterId,
    primaryUserId,
    // `userId` mirrors primaryUserId so it can serve as the supporterIndex sort key.
    userId: primaryUserId,
    status: input.status ?? 'PENDING',
    permissions: input.permissions,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: supporterPk(supporterId),
        SK: userLinkSk(primaryUserId),
        entityType: ENTITY.SUPPORT_LINK,
        ...link,
      },
    }),
  );

  return link;
}

async function listPrimaryUsersBySupporter(
  supporterId: string,
  page: PageArgs,
): Promise<Connection<SupportLink>> {
  if (!supporterId?.trim()) throw new ValidationError('supporterId is required');
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
