/**
 * React Query hooks wrapping the raw admin API. Components use these (never adminApi
 * directly) so caching, loading/error state, and post-mutation invalidation are uniform.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminDeleteTask,
  adminDeleteUser,
  adminGetUserData,
  inviteOrganizationAdmin,
  inviteSupportPerson,
  listAllTasks,
  listAllUsers,
  setSystemAdmin,
  setUserBaseRole,
} from './adminApi';
import type {
  AdminDeleteUserInput,
  InviteUserInput,
  PageArgs,
  SetSystemAdminInput,
  SetUserBaseRoleInput,
} from './apiTypes';

/** Centralized query keys so hooks and invalidation can't drift apart. */
export const adminKeys = {
  users: ['admin', 'users'] as const,
  usersPage: (page: PageArgs) => ['admin', 'users', page] as const,
  tasks: ['admin', 'tasks'] as const,
  tasksPage: (page: PageArgs) => ['admin', 'tasks', page] as const,
  userData: (userId: string) => ['admin', 'userData', userId] as const,
};

// ── Queries ──────────────────────────────────────────────────────────────────────
export function useUsersPage(page: PageArgs) {
  return useQuery({
    queryKey: adminKeys.usersPage(page),
    queryFn: () => listAllUsers(page),
    placeholderData: (prev) => prev, // keep the prior page visible while the next loads
  });
}

export function useTasksPage(page: PageArgs) {
  return useQuery({
    queryKey: adminKeys.tasksPage(page),
    queryFn: () => listAllTasks(page),
    placeholderData: (prev) => prev,
  });
}

/** Full data snapshot for one user. Disabled until a non-empty userId is provided. */
export function useUserData(userId: string | undefined) {
  return useQuery({
    queryKey: adminKeys.userData(userId ?? ''),
    queryFn: () => adminGetUserData(userId as string),
    enabled: Boolean(userId),
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────────
export function useInviteSupportPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserInput) => inviteSupportPerson(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useInviteOrganizationAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserInput) => inviteOrganizationAdmin(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useSetUserBaseRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetUserBaseRoleInput) => setUserBaseRole(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useSetSystemAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetSystemAdminInput) => setSystemAdmin(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useAdminDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => adminDeleteTask(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.tasks }),
  });
}

export function useAdminDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminDeleteUserInput) => adminDeleteUser(input),
    onSuccess: () => {
      // A full user deletion removes their tasks too — refresh both lists.
      qc.invalidateQueries({ queryKey: adminKeys.users });
      qc.invalidateQueries({ queryKey: adminKeys.tasks });
    },
  });
}
