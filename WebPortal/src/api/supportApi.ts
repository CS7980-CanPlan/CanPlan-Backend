/**
 * Raw SupportPerson API functions — one per GraphQL operation, framework-agnostic (no React).
 * React Query hooks in `supportHooks.ts` wrap these; components never call gqlRequest directly.
 */
import type {
  CategoryConnection,
  PageArgs,
  SelectPrimaryUserInput,
  SupportLink,
  SupportLinkConnection,
  TaskAssignmentConnection,
  TaskConnection,
  UnselectPrimaryUserInput,
  UpdateMyUserProfileInput,
  UserProfile,
  UserProfileConnection,
} from './apiTypes';
import { gqlRequest } from './graphqlClient';
import {
  GET_USER_PROFILE,
  LIST_MY_CATEGORIES,
  LIST_MY_ORGANIZATION_USERS,
  LIST_MY_SUPPORT_LIST,
  LIST_TASK_ASSIGNMENTS_FOR_USER,
  LIST_TASKS_BY_OWNER,
  SELECT_PRIMARY_USER,
  UNSELECT_PRIMARY_USER,
  UPDATE_MY_USER_PROFILE,
} from './supportDocuments';

// ── Queries ──────────────────────────────────────────────────────────────────────
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const data = await gqlRequest<{ getUserProfile: UserProfile | null }>(GET_USER_PROFILE, {
    userId,
  });
  return data.getUserProfile;
}

export async function listMySupportList(args: PageArgs = {}): Promise<SupportLinkConnection> {
  const data = await gqlRequest<{ listMySupportList: SupportLinkConnection }>(LIST_MY_SUPPORT_LIST, {
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listMySupportList;
}

export async function listMyOrganizationUsers(
  args: PageArgs = {},
): Promise<UserProfileConnection> {
  const data = await gqlRequest<{ listMyOrganizationUsers: UserProfileConnection }>(
    LIST_MY_ORGANIZATION_USERS,
    { limit: args.limit, nextToken: args.nextToken ?? null },
  );
  return data.listMyOrganizationUsers;
}

export async function listTasksByOwner(
  ownerId: string,
  args: PageArgs = {},
): Promise<TaskConnection> {
  const data = await gqlRequest<{ listTasksByOwner: TaskConnection }>(LIST_TASKS_BY_OWNER, {
    ownerId,
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listTasksByOwner;
}

export async function listMyCategories(
  userId: string,
  args: PageArgs = {},
): Promise<CategoryConnection> {
  const data = await gqlRequest<{ listMyCategories: CategoryConnection }>(LIST_MY_CATEGORIES, {
    userId,
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listMyCategories;
}

export async function listTaskAssignmentsForUser(
  userId: string,
  args: PageArgs = {},
): Promise<TaskAssignmentConnection> {
  const data = await gqlRequest<{ listTaskAssignmentsForUser: TaskAssignmentConnection }>(
    LIST_TASK_ASSIGNMENTS_FOR_USER,
    { userId, limit: args.limit, nextToken: args.nextToken ?? null },
  );
  return data.listTaskAssignmentsForUser;
}

// ── Mutations ────────────────────────────────────────────────────────────────────
/** Update the caller's own profile (displayName / organizationId / accessibilitySettings). */
export async function updateMyUserProfile(
  input: UpdateMyUserProfileInput,
): Promise<UserProfile> {
  const data = await gqlRequest<{ updateMyUserProfile: UserProfile }>(UPDATE_MY_USER_PROFILE, {
    input,
  });
  return data.updateMyUserProfile;
}

export async function selectPrimaryUser(input: SelectPrimaryUserInput): Promise<SupportLink> {
  const data = await gqlRequest<{ selectPrimaryUser: SupportLink }>(SELECT_PRIMARY_USER, { input });
  return data.selectPrimaryUser;
}

export async function unselectPrimaryUser(input: UnselectPrimaryUserInput): Promise<SupportLink> {
  const data = await gqlRequest<{ unselectPrimaryUser: SupportLink }>(UNSELECT_PRIMARY_USER, {
    input,
  });
  return data.unselectPrimaryUser;
}
