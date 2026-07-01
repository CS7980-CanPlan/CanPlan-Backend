/**
 * React Query hooks wrapping the raw admin API. Components use these (never adminApi
 * directly) so caching, loading/error state, and post-mutation invalidation are uniform.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminCreateOrganization,
  adminDeleteOrganization,
  adminDeleteTask,
  adminDeleteUser,
  adminGetUserData,
  adminListOrganizationUsers,
  adminSetUserOrganization,
  adminUpdateOrganization,
  inviteOrganizationAdmin,
  inviteSupportPerson,
  listAllOrganizations,
  listAllTasks,
  listAllUsers,
  setSystemAdmin,
  setUserBaseRole,
} from './adminApi';
import type {
  AdminDeleteUserInput,
  AdminSetUserOrganizationInput,
  CreateOrganizationInput,
  DeleteOrganizationInput,
  InviteUserInput,
  PageArgs,
  SetSystemAdminInput,
  SetUserBaseRoleInput,
  UpdateOrganizationInput,
} from './apiTypes';

/** Centralized query keys so hooks and invalidation can't drift apart. */
export const adminKeys = {
  users: ['admin', 'users'] as const,
  usersPage: (page: PageArgs) => ['admin', 'users', page] as const,
  tasks: ['admin', 'tasks'] as const,
  tasksPage: (page: PageArgs) => ['admin', 'tasks', page] as const,
  userData: (userId: string) => ['admin', 'userData', userId] as const,
  orgs: ['admin', 'orgs'] as const,
  orgsPage: (page: PageArgs) => ['admin', 'orgs', page] as const,
  orgUsers: ['admin', 'orgUsers'] as const,
  orgUsersPage: (organizationId: string, page: PageArgs) =>
    ['admin', 'orgUsers', organizationId, page] as const,
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

export function useOrganizationsPage(page: PageArgs) {
  return useQuery({
    queryKey: adminKeys.orgsPage(page),
    queryFn: () => listAllOrganizations(page),
    placeholderData: (prev) => prev,
  });
}

/** Members of one organization. Disabled until a non-empty organizationId is provided. */
export function useOrganizationUsers(organizationId: string | undefined, page: PageArgs) {
  return useQuery({
    queryKey: adminKeys.orgUsersPage(organizationId ?? '', page),
    queryFn: () => adminListOrganizationUsers(organizationId as string, page),
    enabled: Boolean(organizationId),
    placeholderData: (prev) => prev,
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

export function useAdminCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) => adminCreateOrganization(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.orgs }),
  });
}

export function useAdminUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => adminUpdateOrganization(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.orgs }),
  });
}

export function useAdminDeleteOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteOrganizationInput) => adminDeleteOrganization(input),
    onSuccess: () => {
      // Deleting an org detaches its members — refresh org lists, member rosters, and users.
      qc.invalidateQueries({ queryKey: adminKeys.orgs });
      qc.invalidateQueries({ queryKey: adminKeys.orgUsers });
      qc.invalidateQueries({ queryKey: adminKeys.users });
    },
  });
}

export function useAdminSetUserOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminSetUserOrganizationInput) => adminSetUserOrganization(input),
    onSuccess: () => {
      // A membership change can touch two orgs' rosters (a move) plus the user's own profile.
      qc.invalidateQueries({ queryKey: adminKeys.orgUsers });
      qc.invalidateQueries({ queryKey: adminKeys.users });
    },
  });
}
