/**
 * React Query hooks wrapping the raw SupportPerson API. Components use these (never supportApi
 * directly) so caching, loading/error state, and post-mutation invalidation are uniform.
 *
 * The support list and org roster hooks DRAIN every `nextToken` page before returning:
 * consumers filter them (ACTIVE links, PRIMARY_USER candidates, name lookups), and a single
 * truncated page would silently hide selectable people.
 */
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createAiTask,
  createTask,
  createTaskAssignment,
  createTaskStep,
  deleteReport,
  deleteTask,
  deleteTaskAssignment,
  deleteTaskStep,
  endTaskAssignment,
  generateReport,
  getReportDownloadUrl,
  getReportPdfDownloadUrl,
  getTaskInstance,
  getTaskInstanceViews,
  getTask,
  getUserProfile,
  listAllMyOrganizationUsers,
  listAllMySupportList,
  listAllTaskAssignmentsForUser,
  listAllTaskInstancesForUser,
  listAllTaskInstanceSteps,
  listAllTaskSteps,
  listMyCategories,
  listMySupportedUserReports,
  listReports,
  listTaskAssignmentsForUser,
  listTasksByOwner,
  reorderTaskSteps,
  saveReport,
  selectPrimaryUser,
  unselectPrimaryUser,
  updateMyUserProfile,
  updateTask,
  updateTaskStep,
} from './supportApi';
import type {
  CreateAiTaskInput,
  CreateTaskAssignmentInput,
  CreateTaskInput,
  CreateTaskStepInput,
  DeleteTaskAssignmentInput,
  DeleteTaskStepInput,
  EndTaskAssignmentInput,
  GenerateReportInput,
  ReportConnection,
  ReorderTaskStepsInput,
  ReportTargetInput,
  SaveReportInput,
  SelectPrimaryUserInput,
  SupportedReportFilterInput,
  UnselectPrimaryUserInput,
  UpdateMyUserProfileInput,
  UpdateTaskInput,
  UpdateTaskStepInput,
} from './apiTypes';

const LIST_PAGE_SIZE = 100;
/** Owned-template pages are small so "Load more" is visible well before the 50-task cap. */
const OWNED_TASKS_PAGE_SIZE = 25;
const SUPPORT_CALENDAR_KEY = ['support', 'calendar'] as const;
const SUPPORT_TASK_INSTANCES_KEY = ['support', 'taskInstances'] as const;
const SUPPORT_REPORTS_KEY = ['support', 'reports'] as const;
const SUPPORT_REPORT_DIRECTORY_KEY = [...SUPPORT_REPORTS_KEY, 'directory'] as const;
const REPORTS_PAGE_SIZE = 25;

/** Centralized query keys so hooks and invalidation can't drift apart. */
export const supportKeys = {
  supportList: ['support', 'supportList'] as const,
  orgUsers: ['support', 'orgUsers'] as const,
  profile: (userId: string) => ['support', 'profile', userId] as const,
  tasks: (ownerId: string) => ['support', 'tasks', ownerId] as const,
  categories: (userId: string) => ['support', 'categories', userId] as const,
  assignments: (userId: string) => ['support', 'assignments', userId] as const,
  calendars: SUPPORT_CALENDAR_KEY,
  calendar: (userId: string) => [...SUPPORT_CALENDAR_KEY, userId] as const,
  taskInstances: (userId: string) => [...SUPPORT_TASK_INSTANCES_KEY, userId] as const,
  taskInstancesRange: (userId: string, startDate: string, endDate: string) =>
    [...supportKeys.taskInstances(userId), 'range', startDate, endDate] as const,
  taskInstance: (userId: string, instanceId: string) =>
    [...supportKeys.taskInstances(userId), 'detail', instanceId] as const,
  taskInstanceSteps: (userId: string, instanceId: string) =>
    [...supportKeys.taskInstance(userId, instanceId), 'steps'] as const,
  reports: (userId: string) => [...SUPPORT_REPORTS_KEY, 'user', userId] as const,
  reportDirectory: (filter: SupportedReportFilterInput = {}) =>
    [
      ...SUPPORT_REPORT_DIRECTORY_KEY,
      filter.userId ?? null,
      filter.createdFrom ?? null,
      filter.createdTo ?? null,
    ] as const,
  ownedTasks: (ownerId: string) => ['support', 'ownedTasks', ownerId] as const,
  task: (taskId: string) => ['support', 'task', taskId] as const,
  taskSteps: (taskId: string) => ['support', 'taskSteps', taskId] as const,
};

// ── Queries ──────────────────────────────────────────────────────────────────────
/**
 * The caller's COMPLETE currently-effective support list, all pages drained. Kept in the
 * connection shape ({ items, nextToken: null }) so existing consumers reading `data.items`
 * see the full list without changes.
 */
export function useMySupportList() {
  return useQuery({
    queryKey: supportKeys.supportList,
    queryFn: async () => ({ items: await listAllMySupportList(), nextToken: null }),
  });
}

/** The caller's COMPLETE organization roster, all pages drained (same shape rationale). */
export function useMyOrganizationUsers() {
  return useQuery({
    queryKey: supportKeys.orgUsers,
    queryFn: async () => ({ items: await listAllMyOrganizationUsers(), nextToken: null }),
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

/**
 * Profile lookups for a dynamic set of supported-user ids. De-duplicate and sort first so the
 * returned `{ userId, query }` entries and their query keys remain deterministic when the
 * support-list response order changes.
 */
export function useSupportedUserProfiles(userIds: string[]) {
  const stableUserIds = [...new Set(userIds.map((userId) => userId.trim()).filter(Boolean))].sort();
  const queries = useQueries({
    queries: stableUserIds.map((userId) => ({
      queryKey: supportKeys.profile(userId),
      queryFn: () => getUserProfile(userId),
    })),
  });

  return stableUserIds.map((userId, index) => ({ userId, query: queries[index] }));
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

/**
 * A supported user's virtual + materialized calendar for one inclusive date window.
 * The backend returns the whole window, so there is no pagination to drain here.
 */
export function useUserCalendar(userId: string | undefined, startDate: string, endDate: string) {
  return useQuery({
    queryKey: [...supportKeys.calendar(userId ?? ''), startDate, endDate] as const,
    queryFn: () => getTaskInstanceViews(userId as string, startDate, endDate),
    enabled: Boolean(userId && startDate && endDate),
  });
}

/**
 * ALL real/materialized instances for a supported user in one inclusive, backend-bounded date
 * range. Virtual schedule occurrences are intentionally excluded.
 */
export function useUserTaskInstances(
  userId: string | undefined,
  startDate: string,
  endDate: string,
) {
  return useQuery({
    queryKey: supportKeys.taskInstancesRange(userId ?? '', startDate, endDate),
    queryFn: () => listAllTaskInstancesForUser(userId as string, startDate, endDate),
    enabled: Boolean(userId && startDate && endDate),
  });
}

/** One full materialized instance, including lifecycle completion and timing fields. */
export function useUserTaskInstance(userId: string | undefined, instanceId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.taskInstance(userId ?? '', instanceId ?? ''),
    queryFn: () => getTaskInstance(userId as string, instanceId as string),
    enabled: Boolean(userId && instanceId),
  });
}

/** Every immutable step snapshot for one instance, sorted by numeric order. */
export function useUserTaskInstanceSteps(
  userId: string | undefined,
  instanceId: string | undefined,
) {
  return useQuery({
    queryKey: supportKeys.taskInstanceSteps(userId ?? '', instanceId ?? ''),
    queryFn: () => listAllTaskInstanceSteps(userId as string, instanceId as string),
    enabled: Boolean(userId && instanceId),
  });
}

/**
 * Saved reports for one supported primary user, newest-first and cursor-paginated. A presigned
 * download URL is requested only when the user chooses a report, so expired URLs are not cached.
 */
export function useReports(userId: string | undefined) {
  return useInfiniteQuery({
    queryKey: supportKeys.reports(userId ?? ''),
    queryFn: ({ pageParam }) =>
      listReports(userId as string, {
        limit: REPORTS_PAGE_SIZE,
        nextToken: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextToken ?? undefined,
    enabled: Boolean(userId),
  });
}

/**
 * Newest-first saved reports across every currently supported primary user. Optional directory
 * filters are part of the query key, so multiple applied filter combinations paginate
 * independently and can all be reconciled after save/delete.
 */
export function useMySupportedUserReports(filter: SupportedReportFilterInput = {}) {
  return useInfiniteQuery({
    queryKey: supportKeys.reportDirectory(filter),
    queryFn: ({ pageParam }) =>
      listMySupportedUserReports(filter, {
        limit: REPORTS_PAGE_SIZE,
        nextToken: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextToken ?? undefined,
  });
}

/**
 * ALL of one user's assignments, every page drained for the user-centered management panel.
 * Its key extends
 * `supportKeys.assignments(userId)`, so the assignment-mutation hooks' prefix invalidation
 * refreshes this and the single-page variant together.
 */
export function useUserAssignmentsAll(userId: string | undefined) {
  return useQuery({
    queryKey: [...supportKeys.assignments(userId ?? ''), 'all'] as const,
    queryFn: () => listAllTaskAssignmentsForUser(userId as string),
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
      qc.invalidateQueries({ queryKey: supportKeys.calendars });
      // An organization change can revoke every delegated relationship immediately. Remove
      // lifecycle/step/report details so stale supported-user data cannot remain in cache.
      qc.removeQueries({ queryKey: SUPPORT_TASK_INSTANCES_KEY });
      qc.removeQueries({ queryKey: SUPPORT_REPORTS_KEY });
    },
  });
}

export function useSelectPrimaryUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SelectPrimaryUserInput) => selectPrimaryUser(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: supportKeys.supportList });
      // A newly effective relationship can make that user's saved reports visible globally.
      qc.invalidateQueries({ queryKey: SUPPORT_REPORT_DIRECTORY_KEY });
    },
  });
}

export function useUnselectPrimaryUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UnselectPrimaryUserInput) => unselectPrimaryUser(input),
    onSuccess: (link) => {
      qc.invalidateQueries({ queryKey: supportKeys.supportList });
      qc.removeQueries({ queryKey: supportKeys.calendar(link.primaryUserId) });
      qc.removeQueries({ queryKey: supportKeys.taskInstances(link.primaryUserId) });
      // Directory pages can contain this user's report metadata. Clear the entire reports
      // domain immediately so a revoked relationship never leaves cached cross-user results.
      qc.removeQueries({ queryKey: SUPPORT_REPORTS_KEY });
    },
  });
}

// ── AI progress reports ─────────────────────────────────────────────────────────
/** Generate an unsaved preview; saving remains an explicit second action. */
export function useGenerateReport() {
  return useMutation({
    mutationFn: (input: GenerateReportInput) => generateReport(input),
  });
}

/**
 * Persist an exact generated preview. The supported user id is hook context only—it is not
 * added to SaveReportInput because the backend resolves it from the signed draft token.
 */
export function useSaveReport(userId: string | undefined) {
  const qc = useQueryClient();
  const refreshReports = () => {
    // One save changes every global-directory filter that can contain it and the selected
    // user's report-list/detail cache.
    qc.invalidateQueries({ queryKey: SUPPORT_REPORT_DIRECTORY_KEY });
    if (userId) qc.invalidateQueries({ queryKey: supportKeys.reports(userId) });
  };

  return useMutation({
    mutationFn: (input: SaveReportInput) => saveReport(input),
    onSuccess: refreshReports,
    // A lost response can hide a successful non-idempotent save. Refresh before any retry.
    onError: refreshReports,
  });
}

/** Mint a fresh URL on demand instead of caching a presigned URL that expires. */
export function useReportDownloadUrl() {
  return useMutation({
    mutationFn: (input: ReportTargetInput) => getReportDownloadUrl(input.userId, input.reportId),
  });
}

/** Mint a fresh PDF URL on demand instead of caching an expiring presigned attachment. */
export function useReportPdfDownloadUrl() {
  return useMutation({
    mutationFn: (input: ReportTargetInput) => getReportPdfDownloadUrl(input.userId, input.reportId),
  });
}

/** Permanently delete one saved report, then reconcile the paginated metadata list. */
export function useDeleteReport(userId: string | undefined) {
  const qc = useQueryClient();
  const removeCachedReport = (reportId: string) => {
    const withoutReport = (
      cached: InfiniteData<ReportConnection, string | null> | undefined,
    ): InfiniteData<ReportConnection, string | null> | undefined =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.filter((report) => report.reportId !== reportId),
            })),
          }
        : cached;

    qc.setQueriesData<InfiniteData<ReportConnection, string | null>>(
      { queryKey: SUPPORT_REPORT_DIRECTORY_KEY },
      withoutReport,
    );
    if (userId) {
      qc.setQueryData<InfiniteData<ReportConnection, string | null>>(
        supportKeys.reports(userId),
        withoutReport,
      );
    }
  };
  const refreshReports = () => {
    // A deletion affects every directory filter that may contain the row, plus its per-user list.
    qc.invalidateQueries({ queryKey: SUPPORT_REPORT_DIRECTORY_KEY });
    if (userId) qc.invalidateQueries({ queryKey: supportKeys.reports(userId) });
  };

  return useMutation({
    mutationFn: (reportId: string) => deleteReport(userId as string, reportId),
    onSuccess: (_deleted, reportId) => {
      removeCachedReport(reportId);
      refreshReports();
    },
    // Deletion spans DynamoDB and S3; refresh even when the response is ambiguous.
    onError: refreshReports,
  });
}

// ── Owned task templates (the Tasks module) ──────────────────────────────────────
/**
 * The caller's OWN task templates, cursor-paginated ("Load more"). `ownerId` must be the
 * authenticated SupportPerson's Cognito sub — this hook is never pointed at a supported
 * user (that read-only view is `useTasksByOwner` on the user-detail page).
 */
export function useOwnedTasks(ownerId: string | undefined) {
  return useInfiniteQuery({
    queryKey: supportKeys.ownedTasks(ownerId ?? ''),
    queryFn: ({ pageParam }) =>
      listTasksByOwner(ownerId as string, {
        limit: OWNED_TASKS_PAGE_SIZE,
        nextToken: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextToken ?? undefined,
    enabled: Boolean(ownerId),
  });
}

/** One task template (owner or delegated/assigned read). Disabled until taskId is known. */
export function useTask(taskId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.task(taskId ?? ''),
    queryFn: () => getTask(taskId as string),
    enabled: Boolean(taskId),
  });
}

/**
 * ALL of a task's steps, sorted by order. Drains every `nextToken` page up front because
 * reorder/append must operate on the complete current set (≤ 99 steps, so this is 1 page).
 */
export function useTaskSteps(taskId: string | undefined) {
  return useQuery({
    queryKey: supportKeys.taskSteps(taskId ?? ''),
    queryFn: () => listAllTaskSteps(taskId as string),
    enabled: Boolean(taskId),
  });
}

/** Invalidate everything the task detail page reads for one task. */
function invalidateTaskDetail(qc: ReturnType<typeof useQueryClient>, taskId: string) {
  qc.invalidateQueries({ queryKey: supportKeys.task(taskId) });
  qc.invalidateQueries({ queryKey: supportKeys.taskSteps(taskId) });
}

/** Invalidate every cached list of this owner's tasks (paged module list + legacy list). */
function invalidateOwnerTaskLists(qc: ReturnType<typeof useQueryClient>, ownerId?: string) {
  if (!ownerId) return;
  qc.invalidateQueries({ queryKey: supportKeys.ownedTasks(ownerId) });
  qc.invalidateQueries({ queryKey: supportKeys.tasks(ownerId) });
}

/** Generate a non-persisted AI task preview; no query cache changes until createTask is used. */
export function useCreateAiTask() {
  return useMutation({
    mutationFn: (input: CreateAiTaskInput) => createAiTask(input),
  });
}

/** Create an OWNED task template. Invalidates the owner's template list. */
export function useCreateTask(ownerId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: () => invalidateOwnerTaskLists(qc, ownerId),
    // A transport failure can hide a successful non-idempotent create; mark lists stale so
    // reviewing them before retrying reveals any task that did reach the backend.
    onError: () => invalidateOwnerTaskLists(qc, ownerId),
  });
}

export function useUpdateTask(ownerId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => updateTask(input),
    onSuccess: (task) => {
      invalidateTaskDetail(qc, task.taskId);
      invalidateOwnerTaskLists(qc, ownerId);
      // Calendar titles are resolved live from task metadata.
      qc.invalidateQueries({ queryKey: supportKeys.calendars });
    },
  });
}

/** Delete an owned template. The backend rejects it while active assignments reference it. */
export function useDeleteTask(ownerId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => deleteTask(taskId),
    onSuccess: (deleted) => {
      qc.removeQueries({ queryKey: supportKeys.task(deleted.taskId) });
      qc.removeQueries({ queryKey: supportKeys.taskSteps(deleted.taskId) });
      invalidateOwnerTaskLists(qc, ownerId);
      qc.invalidateQueries({ queryKey: supportKeys.calendars });
    },
  });
}

export function useCreateTaskStep(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskStepInput) => createTaskStep(input),
    onSuccess: () => invalidateTaskDetail(qc, taskId),
  });
}

export function useUpdateTaskStep(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskStepInput) => updateTaskStep(input),
    onSuccess: () => invalidateTaskDetail(qc, taskId),
  });
}

export function useDeleteTaskStep(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteTaskStepInput) => deleteTaskStep(input),
    onSuccess: () => invalidateTaskDetail(qc, taskId),
  });
}

export function useReorderTaskSteps(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderTaskStepsInput) => reorderTaskSteps(input),
    onSuccess: () => invalidateTaskDetail(qc, taskId),
  });
}

// ── Task-assignment mutations (schedule rules for a target user) ─────────────────
/** Create a schedule rule. Invalidates the TARGET user's assignment list. */
export function useCreateTaskAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskAssignmentInput) => createTaskAssignment(input),
    onSuccess: (assignment) => {
      qc.invalidateQueries({ queryKey: supportKeys.assignments(assignment.userId) });
      qc.invalidateQueries({ queryKey: supportKeys.calendar(assignment.userId) });
    },
    // createTaskAssignment allocates a new id, so an ambiguous response must be reconciled
    // against the target user's refreshed list before the caller retries.
    onError: (_error, input) => {
      qc.invalidateQueries({ queryKey: supportKeys.assignments(input.userId) });
      qc.invalidateQueries({ queryKey: supportKeys.calendar(input.userId) });
    },
  });
}

export function useEndTaskAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EndTaskAssignmentInput) => endTaskAssignment(input),
    onSuccess: (assignment) => {
      qc.invalidateQueries({ queryKey: supportKeys.assignments(assignment.userId) });
      qc.invalidateQueries({ queryKey: supportKeys.calendar(assignment.userId) });
    },
  });
}

export function useDeleteTaskAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteTaskAssignmentInput) => deleteTaskAssignment(input),
    onSuccess: (assignment) => {
      qc.invalidateQueries({ queryKey: supportKeys.assignments(assignment.userId) });
      qc.invalidateQueries({ queryKey: supportKeys.calendar(assignment.userId) });
    },
  });
}
