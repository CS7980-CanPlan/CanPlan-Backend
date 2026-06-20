import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ENTITY,
  ORG_INDEX,
  PROFILE_SK,
  SUPPORTER_INDEX,
  supporterPk,
  userLinkSk,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { ValidationError, UnauthorizedError } from '../../shared/response';
import { roleFromIdentity } from '../../shared/roles';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Connection,
  CreateMyUserProfileInput,
  CreateSupportLinkInput,
  SupportLink,
  UserProfile,
} from '../../shared/types';

/**
 * Users domain Lambda — UserProfile + SupportLink operations, routed by the
 * resolved GraphQL field. One Lambda per domain keeps cold-start surface and IAM
 * roles small while preserving the repo's one-resolver-per-field wiring.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<UserProfile | SupportLink | Connection<UserProfile> | Connection<SupportLink> | null> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createUserProfile':
      return createMyUserProfile(event.identity, args.input as CreateMyUserProfileInput);
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
 */
async function createMyUserProfile(
  identity: AppSyncIdentity | undefined,
  input: CreateMyUserProfileInput,
): Promise<UserProfile> {
  const userId = identity?.sub?.trim();
  if (!userId) throw new UnauthorizedError('Unauthorized: an authenticated user is required');

  // Throws ValidationError unless the caller has exactly one base-role group.
  const role = roleFromIdentity(identity);
  const email = (identity?.claims?.email as string | undefined)?.trim();
  const displayName = input?.displayName?.trim();
  if (!displayName) throw new ValidationError('displayName is required and cannot be empty');

  const now = new Date().toISOString();
  const profile: UserProfile = {
    userId,
    role,
    displayName,
    email,
    organizationId: input?.organizationId?.trim(),
    accessibilitySettings: input?.accessibilitySettings,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: userPk(userId), SK: PROFILE_SK, entityType: ENTITY.USER_PROFILE, ...profile },
    }),
  );

  return profile;
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
