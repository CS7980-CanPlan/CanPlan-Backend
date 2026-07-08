/**
 * React Query hooks wrapping the raw SupportPerson API. Components use these (never supportApi
 * directly) so caching, loading/error state, and post-mutation invalidation are uniform.
 *
 * The support list and org roster are small (people in one organization), so each list hook
 * fetches a single generous page rather than exposing cursor pagination.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getUserProfile,
  listMyCategories,
  listMyOrganizationUsers,
  listMySupportList,
  listTaskAssignmentsForUser,
  listTasksByOwner,
  selectPrimaryUser,
  unselectPrimaryUser,
  updateMyUserProfile,
} from './supportApi';
import type {
  SelectPrimaryUserInput,
  UnselectPrimaryUserInput,
  UpdateMyUserProfileInput,
} from './apiTypes';

const LIST_PAGE_SIZE = 100;

/** Centralized query keys so hooks and invalidation can't drift apart. */
export const supportKeys = {
  supportList: ['support', 'supportList'] as const,
  orgUsers: ['support', 'orgUsers'] as const,
  profile: (userId: string) => ['support', 'profile', userId] as const,
  tasks: (ownerId: string) => ['support', 'tasks', ownerId] as const,
  categories: (userId: string) => ['support', 'categories', userId] as const,
  assignments: (userId: string) => ['support', 'assignments', userId] as const,
};

// ── Queries ──────────────────────────────────────────────────────────────────────
/** The caller's own support list (primary users they have selected — ACTIVE + REVOKED). */
export function useMySupportList() {
  return useQuery({
    queryKey: supportKeys.supportList,
    queryFn: () => listMySupportList({ limit: LIST_PAGE_SIZE }),
  });
}

/** The caller's own organization roster (used to pick primary users to support). */
export function useMyOrganizationUsers() {
  return useQuery({
    queryKey: supportKeys.orgUsers,
    queryFn: () => listMyOrganizationUsers({ limit: LIST_PAGE_SIZE }),
  });
}

/** One user's profile. Disabled until a non-empty userId is provided. */
export function useUserProfile(userId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.profile(userId ?? ''),
    queryFn: () => getUserProfile(userId as string),
    enabled: Boolean(userId),
  });
}

/** A supported user's task templates (delegated access). Disabled until an ownerId is provided. */
export function useTasksByOwner(ownerId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.tasks(ownerId ?? ''),
    queryFn: () => listTasksByOwner(ownerId as string, { limit: LIST_PAGE_SIZE }),
    enabled: Boolean(ownerId),
  });
}

/** A supported user's categories (delegated access). Disabled until a userId is provided. */
export function useUserCategories(userId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.categories(userId ?? ''),
    queryFn: () => listMyCategories(userId as string, { limit: LIST_PAGE_SIZE }),
    enabled: Boolean(userId),
  });
}

/** A supported user's schedule rules (delegated access). Disabled until a userId is provided. */
export function useUserAssignments(userId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.assignments(userId ?? ''),
    queryFn: () => listTaskAssignmentsForUser(userId as string, { limit: LIST_PAGE_SIZE }),
    enabled: Boolean(userId),
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────────
/**
 * Update the caller's own profile. Invalidates the caller's own cached profile plus the org
 * roster and support list (changing organization moves the caller and can affect delegation).
 */
export function useUpdateMyUserProfile(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyUserProfileInput) => updateMyUserProfile(input),
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: supportKeys.profile(userId) });
      qc.invalidateQueries({ queryKey: supportKeys.orgUsers });
      qc.invalidateQueries({ queryKey: supportKeys.supportList });
    },
  });
}

export function useSelectPrimaryUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SelectPrimaryUserInput) => selectPrimaryUser(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: supportKeys.supportList }),
  });
}

export function useUnselectPrimaryUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UnselectPrimaryUserInput) => unselectPrimaryUser(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: supportKeys.supportList }),
  });
}
