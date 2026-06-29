/**
 * Raw admin API functions — one per GraphQL operation, framework-agnostic (no React).
 * React Query hooks in `adminHooks.ts` wrap these; components never call gqlRequest directly.
 */
import type {
  AdminDeleteUserInput,
  AdminDeleteUserResult,
  AdminUserData,
  AdminUserResult,
  InviteUserInput,
  PageArgs,
  SetSystemAdminInput,
  SetUserBaseRoleInput,
  Task,
  TaskConnection,
  UserProfileConnection,
} from './apiTypes';
import { gqlRequest } from './graphqlClient';
import {
  ADMIN_DELETE_TASK,
  ADMIN_DELETE_USER,
  ADMIN_GET_USER_DATA,
  INVITE_ORGANIZATION_ADMIN,
  INVITE_SUPPORT_PERSON,
  LIST_ALL_TASKS,
  LIST_ALL_USERS,
  SET_SYSTEM_ADMIN,
  SET_USER_BASE_ROLE,
} from './graphqlDocuments';

// ── Queries ──────────────────────────────────────────────────────────────────────
export async function listAllUsers(args: PageArgs = {}): Promise<UserProfileConnection> {
  const data = await gqlRequest<{ listAllUsers: UserProfileConnection }>(LIST_ALL_USERS, {
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listAllUsers;
}

export async function listAllTasks(args: PageArgs = {}): Promise<TaskConnection> {
  const data = await gqlRequest<{ listAllTasks: TaskConnection }>(LIST_ALL_TASKS, {
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listAllTasks;
}

/** Full read-only snapshot of one user's data (profile, tasks, categories, task assignments, links). */
export async function adminGetUserData(userId: string): Promise<AdminUserData> {
  const data = await gqlRequest<{ adminGetUserData: AdminUserData }>(ADMIN_GET_USER_DATA, {
    userId,
  });
  return data.adminGetUserData;
}

// ── Mutations ────────────────────────────────────────────────────────────────────
export async function inviteSupportPerson(input: InviteUserInput): Promise<AdminUserResult> {
  const data = await gqlRequest<{ inviteSupportPerson: AdminUserResult }>(INVITE_SUPPORT_PERSON, {
    input,
  });
  return data.inviteSupportPerson;
}

export async function inviteOrganizationAdmin(input: InviteUserInput): Promise<AdminUserResult> {
  const data = await gqlRequest<{ inviteOrganizationAdmin: AdminUserResult }>(
    INVITE_ORGANIZATION_ADMIN,
    { input },
  );
  return data.inviteOrganizationAdmin;
}

export async function setUserBaseRole(input: SetUserBaseRoleInput): Promise<AdminUserResult> {
  const data = await gqlRequest<{ setUserBaseRole: AdminUserResult }>(SET_USER_BASE_ROLE, { input });
  return data.setUserBaseRole;
}

export async function setSystemAdmin(input: SetSystemAdminInput): Promise<AdminUserResult> {
  const data = await gqlRequest<{ setSystemAdmin: AdminUserResult }>(SET_SYSTEM_ADMIN, { input });
  return data.setSystemAdmin;
}

/** Returns the deleted task, or null when it was already gone. */
export async function adminDeleteTask(taskId: string): Promise<Task | null> {
  const data = await gqlRequest<{ adminDeleteTask: Task | null }>(ADMIN_DELETE_TASK, { taskId });
  return data.adminDeleteTask;
}

export async function adminDeleteUser(
  input: AdminDeleteUserInput,
): Promise<AdminDeleteUserResult> {
  const data = await gqlRequest<{ adminDeleteUser: AdminDeleteUserResult }>(ADMIN_DELETE_USER, {
    input,
  });
  return data.adminDeleteUser;
}
