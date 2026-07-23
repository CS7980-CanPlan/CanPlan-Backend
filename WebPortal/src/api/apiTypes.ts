/**
 * Strict TypeScript types mirroring the backend AppSync admin schema
 * (graphql/schema.graphql). Inputs/results here must stay in sync with it.
 */

// ── Enums ──────────────────────────────────────────────────────────────────────
export type UserRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';
/** The base role an admin can assign (mirrors UserRole; SystemAdmin is not a base role). */
export type AdminBaseRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';
export type AiTaskGroundingMode = 'GROUNDED_ONLY' | 'ALLOW_UNGROUNDED_FALLBACK';
export type AiTaskGenerationSource = 'CORPUS' | 'UNGROUNDED_AI';

// ── Entity shapes (only the fields the portal reads) ─────────────────────────────
export interface UserProfile {
  userId: string;
  role: UserRole | null;
  displayName?: string | null;
  email?: string | null;
  organizationId?: string | null;
  defaultCategoryId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Task {
  taskId: string;
  ownerId: string;
  title: string;
  categoryId?: string | null;
  /** Per-owner display order (gaps allowed). Null only on un-migrated legacy rows. */
  order?: number | null;
  description?: string | null;
  /** Optional cover image asset id (read-only in this portal — media is out of scope). */
  coverImageAssetId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Populated only on the createTask response (the steps it just wrote). */
  steps?: TaskStep[] | null;
}

/** One ordered text step of a Task template (media assets are not read by this portal). */
export interface TaskStep {
  stepId: string;
  taskId: string;
  order: number;
  text: string;
  description?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** A source passage supporting one AI-generated preview step. */
export interface Citation {
  chunkId: string;
  title: string;
  url?: string | null;
  snippet?: string | null;
}

/** One ordered step in an AI-generated task preview (not a persisted TaskStep). */
export interface GeneratedAiTaskStep {
  text: string;
  citations: Citation[];
}

/** A createAiTask preview. The caller must explicitly persist it later with createTask. */
export interface GeneratedAiTask {
  title: string;
  steps: GeneratedAiTaskStep[];
  grounded: boolean;
  source: AiTaskGenerationSource;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface Category {
  categoryId: string;
  ownerId: string;
  name: string;
  color?: string | null;
  sortOrder?: number | null;
  isDefault: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type TaskAssignmentScheduleType = 'ONE_TIME' | 'RECURRING';

/** A schedule rule binding a Task template to a user (no status/step completion). */
export interface TaskAssignment {
  assignmentId: string;
  taskId: string;
  userId: string;
  assignedBy?: string | null;
  scheduleType: TaskAssignmentScheduleType;
  scheduledFor?: string | null;
  scheduleRule?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  startTime?: string | null;
  timezone: string;
  active: boolean;
  endedAt?: string | null;
  assignedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type TaskInstanceStatus =
  | 'TO_DO'
  | 'IN_PROGRESS'
  | 'OVERDUE'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'CANCELLED';

/**
 * One real/materialized occurrence of a TaskAssignment. Unlike TaskInstanceView, this carries
 * lifecycle and timing details and is never a virtual schedule occurrence.
 */
export interface TaskInstance {
  instanceId: string;
  assignmentId: string;
  taskId: string;
  userId: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduledFor: string;
  timezone: string;
  status: TaskInstanceStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  skippedAt?: string | null;
  cancelledAt?: string | null;
  activeStepId?: string | null;
  activeStepStartedAt?: string | null;
  activeDurationSeconds: number;
  elapsedSeconds?: number | null;
  isException?: boolean | null;
  createdAt: string;
  updatedAt?: string | null;
}

/** An immutable TaskStep snapshot plus completion/timing state for one materialized instance. */
export interface TaskInstanceStep {
  instanceId: string;
  assignmentId: string;
  taskId: string;
  stepId: string;
  order: number;
  text: string;
  completed: boolean;
  completedAt?: string | null;
  firstStartedAt?: string | null;
  lastStartedAt?: string | null;
  activeDurationSeconds: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * AWSJSON is transported by AppSync as a JSON-encoded string. Keep that wire representation
 * explicit: report drafts must send these exact strings back to saveReport without editing.
 */
export type AwsJsonString = string;

export interface ReportScope {
  userId: string;
}

export interface ReportDateRange {
  from: string;
  to: string;
}

/** Deterministic statistics computed by the backend over materialized task instances. */
export interface ReportStats {
  meta: {
    userId: string;
    from: string;
    to: string;
    basis: 'attempted-instances-only';
    totalInstances: number;
  };
  completion: {
    completed: number;
    skipped: number;
    cancelled: number;
    overdue: number;
    inProgress: number;
    toDo: number;
    completionRate: number;
  };
  trend: Array<{
    weekStart: string;
    completed: number;
    total: number;
    completionRate: number;
  }>;
  byCategory: Array<{
    categoryId: string;
    categoryName: string;
    completed: number;
    total: number;
    completionRate: number;
  }>;
  byTask: Array<{
    taskId: string;
    title: string;
    completed: number;
    total: number;
    completionRate: number;
  }>;
  stepDwell: Array<{
    taskId: string;
    title: string;
    stepOrder: number;
    stepText: string;
    samples: number;
    avgSeconds: number;
  }>;
  focus: {
    byTask: Array<{
      taskId: string;
      title: string;
      samples: number;
      avgActiveSeconds: number;
    }>;
    focusRatio: number | null;
  };
  skipPatterns: {
    byTask: Array<{ taskId: string; title: string; skipped: number }>;
    /** Twenty-four hourly buckets, indexed from 0 through 23. */
    byHour: number[];
  };
  abandonment: Array<{
    instanceId: string;
    taskId: string;
    title: string;
    stalledAtStepOrder: number | null;
  }>;
  /** Twenty-four completion buckets, indexed from 0 through 23. */
  timeOfDay: number[];
}

/**
 * An unsaved report preview. AWSJSON properties stay encoded so this exact object can safely
 * drive SaveReportInput; parse copies for rendering rather than changing these strings.
 */
export interface GeneratedReport {
  draftToken: string;
  scope: AwsJsonString;
  dateRange: AwsJsonString;
  generatedAt: string;
  narrative: string;
  stats: AwsJsonString;
}

/** A generated preview with its AWSJSON fields decoded for read-only presentation. */
export interface ParsedGeneratedReport extends Omit<
  GeneratedReport,
  'scope' | 'dateRange' | 'stats'
> {
  scope: ReportScope;
  dateRange: ReportDateRange;
  stats: ReportStats;
}

/**
 * One saved report. listReports returns metadata (`narrative`/`stats` are null); saveReport
 * echoes the newly saved narrative and stats inline.
 */
export interface Report {
  reportId: string;
  scope: AwsJsonString | null;
  dateRange: AwsJsonString | null;
  s3Key: string | null;
  createdBy: string | null;
  createdAt: string;
  narrative: string | null;
  stats: AwsJsonString | null;
}

/** The raw JSON document returned by HTTP GET against a report download URL. */
export interface ReportDocument {
  reportId: string;
  scope: ReportScope;
  dateRange: ReportDateRange;
  createdBy: string;
  createdAt: string;
  stats: ReportStats;
  narrative: string;
}

export interface ReportDownloadTarget {
  downloadUrl: string;
  s3Key: string;
  expiresIn: number;
}

/**
 * One calendar occurrence returned by getTaskInstanceViews. A virtual occurrence comes from
 * an active schedule rule and has no persisted TaskInstance yet (`instanceId: null`).
 */
export interface TaskInstanceView {
  instanceId: string | null;
  assignmentId: string;
  taskId: string;
  userId: string;
  title: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduledFor: string;
  timezone: string;
  status: TaskInstanceStatus;
  isVirtual: boolean;
  isException: boolean;
}

export type SupportLinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';

export interface SupportLink {
  supporterId: string;
  primaryUserId: string;
  userId: string;
  status: SupportLinkStatus;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** Full read-only snapshot of one user's data (adminGetUserData). */
export interface AdminUserData {
  userId: string;
  profile: UserProfile | null;
  tasks: Task[];
  categories: Category[];
  taskAssignments: TaskAssignment[];
  supportLinks: SupportLink[];
}

/** An organization users can belong to (managed only by SystemAdmin). */
export interface Organization {
  organizationId: string;
  name: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserProfileConnection {
  items: UserProfile[];
  nextToken: string | null;
}

export interface TaskConnection {
  items: Task[];
  nextToken: string | null;
}

export interface TaskStepConnection {
  items: TaskStep[];
  nextToken: string | null;
}

export interface SupportLinkConnection {
  items: SupportLink[];
  nextToken: string | null;
}

export interface CategoryConnection {
  items: Category[];
  nextToken: string | null;
}

export interface TaskAssignmentConnection {
  items: TaskAssignment[];
  nextToken: string | null;
}

/** getTaskInstanceViews always returns the complete requested window (`nextToken: null`). */
export interface TaskInstanceViewConnection {
  items: TaskInstanceView[];
  nextToken: string | null;
}

/** A page of real/materialized TaskInstance rows (never virtual schedule occurrences). */
export interface TaskInstanceConnection {
  items: TaskInstance[];
  nextToken: string | null;
}

export interface TaskInstanceStepConnection {
  items: TaskInstanceStep[];
  nextToken: string | null;
}

/** Saved reports are returned newest-first. */
export interface ReportConnection {
  items: Report[];
  nextToken: string | null;
}

export interface OrganizationConnection {
  items: Organization[];
  nextToken: string | null;
}

// ── Mutation result shapes ───────────────────────────────────────────────────────
export interface AdminUserResult {
  userId: string;
  email: string | null;
  groups: string[];
  profile: UserProfile | null;
}

export interface AdminDeleteUserResult {
  userId: string;
  deletedTasks: number;
  deletedUserItems: number;
  deletedSupportLinks: number;
  deletedCognitoUser: boolean;
}

/** Result of adminDeleteOrganization: the removed org plus how many members were detached. */
export interface AdminDeleteOrganizationResult {
  organization: Organization;
  removedUsers: number;
}

// ── Mutation inputs ──────────────────────────────────────────────────────────────
export interface InviteUserInput {
  email: string;
  displayName?: string;
  organizationId?: string;
}

export interface SetUserBaseRoleInput {
  userId: string;
  role: AdminBaseRole;
}

export interface SetSystemAdminInput {
  userId: string;
  enabled: boolean;
}

export interface AdminDeleteUserInput {
  userId: string;
  deleteCognitoUser?: boolean;
  disableFirst?: boolean;
}

export interface CreateOrganizationInput {
  name: string;
}

export interface UpdateOrganizationInput {
  organizationId: string;
  name: string;
}

export interface DeleteOrganizationInput {
  organizationId: string;
}

/** Admin sets/clears another user's org: a non-null id joins that org; explicit null clears it. */
export interface AdminSetUserOrganizationInput {
  userId: string;
  organizationId: string | null;
}

// ── Self-profile input (any signed-in user, edits their OWN profile) ─────────────
/**
 * Partial update of the caller's OWN profile. Omit a field to leave it unchanged.
 * `organizationId`: a non-empty id joins that org (must exist & not be deleting); explicit
 * `null` clears membership. `accessibilitySettings` is a full replacement (JSON string).
 */
export interface UpdateMyUserProfileInput {
  displayName?: string;
  accessibilitySettings?: string | null;
  organizationId?: string | null;
}

// ── SupportPerson inputs ───────────────────────────────────────────────────────
/** A SupportPerson selects a PRIMARY_USER in their org to support (supporter = caller). */
export interface SelectPrimaryUserInput {
  primaryUserId: string;
}

/** A SupportPerson un-selects a previously selected primary user (soft-revoke). */
export interface UnselectPrimaryUserInput {
  primaryUserId: string;
}

// ── AI progress-report inputs (SupportPerson for a supported primary user) ──────
/** Inclusive YYYY-MM-DD date window. The backend permits at most 366 calendar days. */
export interface GenerateReportInput {
  userId: string;
  from: string;
  to: string;
}

/**
 * Optional filters for the SupportPerson's cross-user saved-report directory.
 * Omitting every field returns the newest reports for all currently supported users.
 */
export interface SupportedReportFilterInput {
  userId?: string;
  createdFrom?: string;
  createdTo?: string;
}

/**
 * The exact, unmodified generateReport response fields. The signed token expires after
 * 15 minutes; changing any field makes backend verification fail.
 */
export interface SaveReportInput {
  draftToken: string;
  scope: AwsJsonString;
  dateRange: AwsJsonString;
  generatedAt: string;
  narrative: string;
  stats: AwsJsonString;
}

export interface ReportTargetInput {
  userId: string;
  reportId: string;
}

// ── Task-template inputs (SupportPerson-owned templates) ─────────────────────────
/**
 * Generate a task preview without persisting it. Omit `stepCount` to let the model choose
 * (up to 20); when supplied it must be an integer from 1 through 20.
 */
export interface CreateAiTaskInput {
  query: string;
  /** Omitted by callers only when they want the backend's GROUNDED_ONLY default. */
  groundingMode?: AiTaskGroundingMode;
  stepCount?: number;
}

/** A nested step at task creation (text + optional description; no media). */
export interface CreateTaskStepNestedInput {
  text: string;
  description?: string;
}

/**
 * Create a task template. This portal NEVER sends `userId` — omitting it makes the
 * authenticated SupportPerson the owner (a non-self userId would create the task under a
 * supported primary user instead, which is not this module's purpose).
 */
export interface CreateTaskInput {
  title: string;
  /** Omit for the owner's default category. Never send a blank string. */
  categoryId?: string;
  description?: string;
  steps?: CreateTaskStepNestedInput[];
}

/** Partial edit of a task template. Omitted fields keep their current value. */
export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  /** Omit ⇒ unchanged. Must be a real owned category id — never a blank string. */
  categoryId?: string;
  description?: string;
}

/** Append ONE step. `order` must equal the task's server-side next append position. */
export interface CreateTaskStepInput {
  taskId: string;
  order: number;
  text: string;
  description?: string;
}

/** Partial edit of one step (text and/or description; media is out of scope here). */
export interface UpdateTaskStepInput {
  taskId: string;
  stepId: string;
  text?: string;
  description?: string | null;
}

export interface DeleteTaskStepInput {
  taskId: string;
  stepId: string;
}

/** One step's target position in a whole-task reorder. */
export interface ReorderTaskStepInput {
  stepId: string;
  order: number;
}

/** Atomic whole-set reorder: every current stepId exactly once with orders 1..N. */
export interface ReorderTaskStepsInput {
  taskId: string;
  steps: ReorderTaskStepInput[];
}

// ── Task-assignment inputs (schedule rules) ──────────────────────────────────────
/**
 * Create a schedule rule binding an OWNED task template to a target user. `assignedBy` is
 * intentionally absent — the backend derives it from the caller and ignores any input value.
 * ONE_TIME sends scheduledFor + timezone; RECURRING sends scheduleRule + startDate +
 * startTime (+ optional endDate) + timezone. Never mix the two shapes.
 */
export interface CreateTaskAssignmentInput {
  taskId: string;
  userId: string;
  scheduleType: TaskAssignmentScheduleType;
  scheduledFor?: string;
  scheduleRule?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  timezone: string;
}

/** End an assignment from `effectiveDate` (YYYY-MM-DD) onward. */
export interface EndTaskAssignmentInput {
  userId: string;
  assignmentId: string;
  effectiveDate: string;
}

/** Soft-delete (stop immediately) an assignment. */
export interface DeleteTaskAssignmentInput {
  userId: string;
  assignmentId: string;
}

// ── Pagination args ──────────────────────────────────────────────────────────────
export interface PageArgs {
  limit?: number;
  nextToken?: string | null;
}
