// Core domain types shared across Lambda functions.
//
// Entity interfaces mirror the GraphQL output types (domain fields only — the
// PK/SK/entityType key attributes are added at write time, see src/shared/keys.ts).

// ── Enums (mirror graphql/schema.graphql) ─────────────────────────────────────
export type UserRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';
export type SupportLinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';
/**
 * Machine-readable reason a SupportLink was soft-revoked (internal; not exposed in GraphQL):
 *  - `ORG_MEMBERSHIP_CHANGED` — either party actually joined, left, or moved organizations, so
 *    affected older relationships were revoked automatically. Sharing an org again does NOT
 *    restore them; the SupportPerson must call selectPrimaryUser again.
 *  - `UNSELECTED` — the SupportPerson explicitly called unselectPrimaryUser.
 */
export type SupportLinkRevocationReason = 'ORG_MEMBERSHIP_CHANGED' | 'UNSELECTED';
export type MediaType = 'IMAGE' | 'AUDIO' | 'VIDEO';
/** createAiTask fallback policy, chosen per request (not by role). */
export type AiTaskGroundingMode = 'GROUNDED_ONLY' | 'ALLOW_UNGROUNDED_FALLBACK';
/** Where a createAiTask result was generated from. */
export type AiTaskGenerationSource = 'CORPUS' | 'UNGROUNDED_AI';

// ── Scheduling enums (mirror graphql/schema.graphql) ──────────────────────────
/** How a TaskAssignment recurs: a single occurrence, or a recurrence rule. */
export type TaskAssignmentScheduleType = 'ONE_TIME' | 'RECURRING';
/**
 * A TaskInstance's lifecycle status. `OVERDUE` is derived at read time (a non-terminal
 * occurrence whose scheduledFor is in the past) — it is never persisted or settable.
 */
export type TaskInstanceStatus =
  | 'TO_DO'
  | 'IN_PROGRESS'
  | 'OVERDUE'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'CANCELLED';
/** The statuses ever persisted on a TaskInstance row (OVERDUE is derived, never stored). */
export type PersistedTaskInstanceStatus =
  | 'TO_DO'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'CANCELLED';

// ── Entities ──────────────────────────────────────────────────────────────────
export interface UserProfile {
  userId: string;
  role: UserRole;
  displayName?: string;
  email?: string;
  organizationId?: string;
  /**
   * Internal organization membership SESSION id (never exposed in GraphQL). A fresh UUID is
   * minted whenever the user actually joins an organization (from none) or moves to a different
   * one; it is removed when they leave; and it is kept unchanged when organizationId is re-set
   * to its current value. SupportLinks snapshot both parties' membership ids at selection time,
   * so a link stops being effective the moment either membership session ends — even if both
   * users later rejoin the same organization. Legacy profiles (org set before this field
   * existed) are initialized lazily at runtime (`ensureOrganizationMembershipId`); no migration.
   */
  organizationMembershipId?: string;
  accessibilitySettings?: Record<string, unknown>;
  /**
   * Id of this user's mandatory default Category (a real Category row with
   * `isDefault: true`). Written atomically with the profile and never null for a
   * profile created/migrated under the current model; Tasks created without an
   * explicit category fall into it.
   */
  defaultCategoryId?: string;
  /**
   * Internal, transactionally-maintained per-owner task counters (not exposed in GraphQL):
   *  - `taskCount`     — number of tasks the owner currently has (≤ 50 cap, enforced on create).
   *  - `nextTaskOrder` — the monotonic `order` value the next created task takes; advanced on
   *                      every create and never reclaimed on delete (so order gaps are allowed).
   * Initialized when the profile is created; backfilled for legacy profiles by the migration.
   */
  taskCount?: number;
  nextTaskOrder?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface SupportLink {
  supporterId: string;
  primaryUserId: string;
  /** Mirror of primaryUserId — the supporterIndex sort key. */
  userId: string;
  status: SupportLinkStatus;
  /**
   * Membership snapshot written by selectPrimaryUser (internal; not exposed in GraphQL):
   * the organization the relationship was selected in, plus BOTH parties' current
   * organizationMembershipId at selection time. Delegated access requires all three to still
   * match the parties' live profiles — an ACTIVE status alone grants nothing. Absent on
   * legacy links (selected before these fields existed), which therefore fail closed until
   * the SupportPerson explicitly re-selects the user; there is no bulk backfill.
   */
  organizationId?: string;
  supporterOrganizationMembershipId?: string;
  primaryUserOrganizationMembershipId?: string;
  /** Why a REVOKED link was revoked (internal); removed when the link is restored to ACTIVE. */
  revokedReason?: SupportLinkRevocationReason;
  createdAt: string;
  updatedAt?: string;
}

/**
 * An organization a UserProfile.organizationId references. PK = ORG#<organizationId>,
 * SK = #META. Created/renamed/deleted only by SystemAdmin admin APIs; PrimaryUser and
 * SupportPerson may READ the directory of joinable organizations via
 * listAvailableOrganizations / getOrganization (deleting orgs are excluded there).
 */
export interface Organization {
  organizationId: string;
  name: string;
  /**
   * Internal, transient marker set while the organization is being deleted and its members'
   * organizationId references are being removed. While present, new memberships may not point
   * at it. Never exposed in the GraphQL Organization type.
   */
  deleting?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A strongly-consistent membership row: one per (organization, user), written in the SAME
 * transaction as any UserProfile.organizationId set/clear so it always mirrors the profile's
 * current org. PK = ORG#<organizationId>, SK = MEMBER#<userId>. It is the source of truth
 * adminDeleteOrganization reads (a consistent Query of the org partition) to detach every member
 * safely — the orgIndex GSI is eventually consistent and could miss a just-joined member. Purely
 * internal: never exposed in GraphQL.
 */
export interface OrganizationMember {
  organizationId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/** A user-owned grouping for tasks (folder-like). PK = USER#<ownerId>, SK = CATEGORY#<categoryId>. */
export interface Category {
  categoryId: string;
  ownerId: string;
  name: string;
  color?: string;
  sortOrder?: number;
  /**
   * True only for the user's reserved default ("No Category") row. Server-controlled
   * (never client-supplied): the default cannot be renamed or deleted; normal
   * categories are always `false`.
   */
  isDefault: boolean;
  /**
   * Internal, transient marker set while a non-default category is being deleted and its
   * Tasks reparented to the default. While present, new Tasks may not attach to (or move
   * into) this category. Never exposed in the GraphQL Category type.
   */
  deleting?: boolean;
  /**
   * Internal, transactionally-maintained count of Tasks currently filed under this
   * category. Incremented/decremented in the same transaction as the Task write
   * (create/category-change/delete/reparent), so deleteCategory can prove — via a
   * strongly-consistent read of `taskCount === 0` — that no Task still references the
   * category before removing it, despite the category GSI being eventually consistent.
   * Never exposed in the GraphQL Category type.
   */
  taskCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  taskId: string;
  ownerId: string;
  title: string;
  /**
   * Id of the real Category this Task belongs to. Always set — a Task with no explicit
   * category is filed under its owner's default category; never null.
   */
  categoryId: string;
  /**
   * Denormalized taskCategoryIndex partition key (<ownerId>#<categoryId>). Written by
   * createTask; not part of the GraphQL Task type — clients query by ownerId/categoryId.
   */
  taskCategoryKey?: string;
  /**
   * Per-owner global display order (gaps allowed; never renumbered on delete). Assigned on
   * create from the owner profile's `nextTaskOrder`; changed in bulk by updateTaskOrder.
   * Absent only on un-migrated legacy rows.
   */
  order?: number;
  /**
   * Internal step bookkeeping for concurrency-safe step management (not exposed in GraphQL):
   *  - `stepCount`     — number of TaskSteps under this task (≤ 99).
   *  - `stepVersion`   — optimistic-concurrency version, bumped on every step-set change
   *                      (create/delete/reorder); a versioned condition serializes appends.
   *  - `nextStepOrder` — the order a standalone append must use (monotonic; reset by reorder).
   * Initialized by createTask; backfilled for legacy rows by the migration.
   */
  stepCount?: number;
  stepVersion?: number;
  nextStepOrder?: number;
  description?: string;
  /**
   * Optional single cover image. The id of an IMAGE MediaAsset (PK=TASK#<taskId>,
   * SK=MEDIA#<assetId>); fetch a viewable URL with getMediaDownloadUrl(taskId, assetId).
   * Null/absent when the task has no cover image.
   */
  coverImageAssetId?: string;
  createdAt: string;
  updatedAt?: string;
  /** Populated by createTask with the steps it just wrote; null on plain getTask. */
  steps?: TaskStep[];
}

export interface TaskStep {
  stepId: string;
  taskId: string;
  order: number;
  text: string;
  /** Optional longer description, separate from `text` and from `Task.description`. */
  description?: string;
  /** API-only hydrated assets: one per MediaType, sorted IMAGE → AUDIO → VIDEO. */
  mediaAssets?: MediaAsset[];
  /** Internal optimistic-concurrency counter for type-specific media updates. */
  mediaVersion?: number;
  createdAt: string;
  updatedAt?: string;
}

/**
 * The schedule rule binding a Task template to a user. It carries NO status or step
 * completion — those live on a TaskInstance / TaskInstanceStep. PK = USER#<userId>,
 * SK = TASK_ASSIGNMENT#<assignmentId>.
 *
 * ONE_TIME assignments use `scheduledFor` + `timezone`; RECURRING assignments use
 * `scheduleRule` (an RRULE) + `startDate` + `startTime` + `timezone` (+ optional `endDate`).
 */
export interface TaskAssignment {
  assignmentId: string;
  taskId: string;
  userId: string;
  assignedBy?: string;
  scheduleType: TaskAssignmentScheduleType;
  /** ONE_TIME: the single occurrence's ISO datetime. */
  scheduledFor?: string;
  /** RECURRING: an RRULE string (e.g. `FREQ=DAILY;INTERVAL=1`). */
  scheduleRule?: string;
  /** RECURRING: inclusive first date (YYYY-MM-DD) the rule may produce occurrences on. */
  startDate?: string;
  /** RECURRING: inclusive last date (YYYY-MM-DD); absent ⇒ open-ended. */
  endDate?: string;
  /** RECURRING: wall-clock time of day each occurrence fires (HH:mm). */
  startTime?: string;
  /** IANA timezone the schedule is interpreted in (both ONE_TIME and RECURRING). */
  timezone: string;
  /** False once the assignment is ended/soft-deleted; only active rows expand to occurrences. */
  active: boolean;
  /** When the assignment was ended/soft-deleted (active=false). */
  endedAt?: string;
  /**
   * Sparse activeTaskAssignmentTaskIndex partition key (= taskId) — present ONLY while the
   * assignment is active, so deleteTask can prove no active assignment references the task.
   * Removed on end/delete. Not part of the GraphQL TaskAssignment type.
   */
  activeTaskAssignmentTaskId?: string;
  assignedAt: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * One concrete occurrence of a scheduled TaskAssignment — created lazily (startTaskInstance,
 * cancelTaskInstance) when a user acts on an occurrence. Stores status + lifecycle timestamps
 * and server-calculated active timing. PK = USER#<userId>,
 * SK = TASK_INSTANCE#<scheduledDate>#<scheduledTime>#<assignmentId>;
 * instanceId = <assignmentId>#<scheduledDate>#<scheduledTime>.
 */
export interface TaskInstance {
  instanceId: string;
  assignmentId: string;
  taskId: string;
  userId: string;
  scheduledDate: string;
  scheduledTime: string;
  /** The occurrence's absolute ISO instant (scheduledDate + scheduledTime in `timezone`). */
  scheduledFor: string;
  timezone: string;
  /**
   * The API-facing status. A stored row only ever holds a PersistedTaskInstanceStatus
   * (TO_DO/IN_PROGRESS/COMPLETED/SKIPPED/CANCELLED), but read paths surface a derived OVERDUE
   * for a past-due non-terminal occurrence — so the public type is the full TaskInstanceStatus.
   * Mutation/storage paths cast to PersistedTaskInstanceStatus (OVERDUE is never written back).
   */
  status: TaskInstanceStatus;
  startedAt?: string;
  completedAt?: string;
  skippedAt?: string;
  cancelledAt?: string;
  /**
   * Active timing (server-calculated — clients never supply durations). `activeStepId` is the
   * step whose timer is currently running (absent when paused / nothing active) and
   * `activeStepStartedAt` the server ISO instant that run began. `activeDurationSeconds` is the
   * accumulated active time across all steps (the currently-running interval is excluded until
   * the step is closed); it is always present on presented rows, defaulting to 0 for freshly
   * started or legacy instances. `elapsedSeconds` is wall-clock startedAt→completedAt, set only
   * when the instance is COMPLETED (it includes paused/idle time, unlike activeDurationSeconds).
   */
  activeStepId?: string;
  activeStepStartedAt?: string;
  activeDurationSeconds: number;
  elapsedSeconds?: number;
  /** True when this instance diverges from the plain schedule (e.g. a cancelled occurrence). */
  isException?: boolean;
  createdAt: string;
  updatedAt?: string;
}

/**
 * An immutable snapshot of one TaskStep captured into one TaskInstance when the instance is
 * started. Per-occurrence completion and server-calculated active timing live here.
 * PK = USER#<userId>, SK = TASK_INSTANCE_STEP#<instanceId>#STEP#<stepId>.
 */
export interface TaskInstanceStep {
  instanceId: string;
  assignmentId: string;
  taskId: string;
  stepId: string;
  order: number;
  text: string;
  completed: boolean;
  completedAt?: string;
  /**
   * Active timing (server-calculated). `firstStartedAt` is stamped once when the step is first
   * started; `lastStartedAt` refreshes on every start. `activeDurationSeconds` is the step's
   * accumulated active time — always present on presented rows, defaulting to 0 until the step
   * is first started (or for a legacy snapshot).
   */
  firstStartedAt?: string;
  lastStartedAt?: string;
  activeDurationSeconds: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result of startTaskInstanceStep / pauseTaskInstanceTimer. `instance` is the updated
 * TaskInstance; `activeStep` is the step now running (null after a pause); `previousStep` is the
 * step that was just closed with its active duration accumulated (null when none was closed).
 */
export interface TaskInstanceTimingResult {
  instance: TaskInstance;
  activeStep: TaskInstanceStep | null;
  previousStep: TaskInstanceStep | null;
}

/**
 * A calendar cell for getTaskInstanceViews: either a real TaskInstance overlaid on its
 * scheduled slot, or a VIRTUAL occurrence that has no real instance yet (`isVirtual: true`,
 * `instanceId: null`).
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

/**
 * One entry of a batchGetTaskInstances result: the requested instanceId paired with the
 * materialized TaskInstance, or `item: null` when no such instance exists for the resolved user.
 * Entries are returned in the same order as the requested ids.
 */
export interface TaskInstanceLookupResult {
  instanceId: string;
  item: TaskInstance | null;
}

export interface MediaAsset {
  assetId: string;
  taskId: string;
  stepId?: string;
  s3Key: string;
  type: MediaType;
  mimeType: string;
  ownerId: string;
  size?: number;
  createdAt: string;
  updatedAt?: string;
}

// ── Mutation inputs ───────────────────────────────────────────────────────────
// Caller creates only their own profile. userId, email, and role are derived
// server-side from the Cognito identity (role from group membership) — they are
// intentionally absent here so a client cannot supply another user's id/email/role.
export interface CreateMyUserProfileInput {
  displayName: string;
  organizationId?: string;
  accessibilitySettings?: Record<string, unknown>;
}

/**
 * Partial update of the caller's OWN profile. The owner is derived from the Cognito
 * identity (never client-supplied), so there is no userId — and userId, email, role,
 * defaultCategoryId, and timestamps are intentionally absent: they cannot be changed here.
 * At least one editable field must be supplied.
 * `displayName`: omitted ⇒ unchanged; otherwise trimmed and may not be empty/whitespace.
 * `accessibilitySettings`: omitted ⇒ unchanged; explicit `null` ⇒ cleared; a non-null value
 * ⇒ FULL replacement of the stored settings (never deep-merged).
 * `organizationId` (MVP self-service org membership): omitted (the key absent) ⇒ unchanged; a
 * non-empty string ⇒ set; explicit `null` ⇒ cleared. Any signed-in user may change their own.
 * A real join/move/leave rotates or clears the internal membership session and soft-revokes
 * affected SupportLinks; re-setting the current org preserves the session and revokes nothing.
 */
export interface UpdateMyUserProfileInput {
  displayName?: string | null;
  accessibilitySettings?: Record<string, unknown> | null;
  organizationId?: string | null;
}

/** Explicitly select/reselect an in-org primary user; writes ACTIVE with a membership snapshot. */
export interface SelectPrimaryUserInput {
  primaryUserId: string;
}

/** A SupportPerson un-selects a primary user (supporter derived from identity). Soft-revokes. */
export interface UnselectPrimaryUserInput {
  primaryUserId: string;
}

// `userId` is optional and selects whose categories to operate on: omitted/null ⇒ the
// authenticated caller (event.identity.sub); a non-self value targets that primary user and
// requires SupportPerson delegated access. The created category is always owned by the target
// user. There is no client-supplied ownerId.
export interface CreateCategoryInput {
  userId?: string | null;
  name: string;
  color?: string;
  sortOrder?: number;
}

/**
 * Partial edit of a category. At least one updatable field (name, color, sortOrder) must be
 * supplied. `userId` is optional: omitted/null ⇒ the caller's own category; a non-self value
 * targets that primary user's category (SupportPerson delegated access). The default category's
 * `name` may not be changed (color/sortOrder are allowed); a normal category may not be renamed
 * to the reserved default name.
 */
export interface UpdateCategoryInput {
  userId?: string | null;
  categoryId: string;
  name?: string;
  color?: string;
  sortOrder?: number;
}

/**
 * Identifies a category to delete. The default cannot be deleted. `userId` is optional:
 * omitted/null ⇒ the caller's own category; a non-self value targets that primary user's
 * category (SupportPerson delegated access).
 */
export interface DeleteCategoryInput {
  userId?: string | null;
  categoryId: string;
}

export interface CreateTaskStepNestedInput {
  text: string;
  /** Optional longer description, separate from `text`. Trimmed when stored. */
  description?: string;
}

// The target owner is resolved server-side: omitted/null `userId` ⇒ the authenticated
// caller (event.identity.sub); a non-self `userId` targets that primary user and requires
// SupportPerson delegated access (assertCanActForUser). No arbitrary client-supplied ownerId
// is honored beyond this delegation path. A Task is a reusable template only: it carries no
// schedule (scheduling lives on TaskAssignment).
export interface CreateTaskInput {
  /** Omitted/null ⇒ the caller. A non-self value requires SupportPerson delegated access. */
  userId?: string;
  title: string;
  /**
   * Optional. Omitted/null ⇒ the owner's default category. A blank string is rejected.
   * A supplied id must be a real, owned, non-deleting Category.
   */
  categoryId?: string;
  description?: string;
  steps?: CreateTaskStepNestedInput[];
  /**
   * Optional cover image: the pending s3Key returned by createTaskCoverImageUploadUrl
   * (after the client PUT the bytes). Omitted ⇒ no cover image.
   */
  coverImageS3Key?: string;
}

// AI one-shot task PREVIEW input: one free-text request, plus the fallback policy and an
// optional requested step count.
export interface CreateAiTaskInput {
  query: string;
  /** Fallback policy; defaults to GROUNDED_ONLY when omitted. */
  groundingMode?: AiTaskGroundingMode;
  /** Requested number of steps. Must be an integer 1..20 if supplied; omitted ⇒ AI chooses (≤ 20). */
  stepCount?: number;
}

/**
 * Partial edit of a Task `#META` item. Only fields that are present (non-null) are
 * changed; `ownerId` and `taskId` are immutable, and steps are edited separately.
 */
export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  /**
   * Omitted ⇒ unchanged. A blank string is rejected. A supplied id must be a real,
   * owned, non-deleting Category belonging to the task's owner.
   */
  categoryId?: string;
  description?: string;
  /**
   * Optional new cover image: the pending s3Key from createTaskCoverImageUploadUrl.
   * Supplied ⇒ replace the cover image (old one is cleaned up after the new one is
   * safely registered); omitted ⇒ leave the current cover image unchanged.
   */
  coverImageS3Key?: string;
}

export interface CreateTaskStepInput {
  taskId: string;
  order: number;
  text: string;
  /** Optional longer description, separate from `text`. Trimmed when stored. */
  description?: string;
  /** Optional initial type-specific media; every entry must supply a non-null asset id. */
  media?: StepMediaUpdateInput[];
}

/**
 * Partial edit of one TaskStep, located by (taskId, stepId). At least one of `text`,
 * `description`, or `media` must be supplied. `text` is trimmed and must be non-empty.
 * `description` semantics: omitted ⇒ unchanged; explicit `null` ⇒ clear; whitespace-only
 * ⇒ rejected; otherwise trimmed and stored. Each `media` entry sets one media type: a
 * non-null asset id attaches a currently-unattached matching asset (replacing that type's
 * prior asset), while null removes the current asset of that type. `stepId`, `taskId`, and
 * `createdAt` are immutable (use reorderTaskSteps to change `order`).
 */
export interface UpdateTaskStepInput {
  taskId: string;
  stepId: string;
  text?: string;
  /** Omitted ⇒ unchanged; `null` ⇒ clear; whitespace-only ⇒ rejected; else trimmed + stored. */
  description?: string | null;
  media?: StepMediaUpdateInput[];
}

/** One type-specific TaskStep media change; types must be unique within one request. */
export interface StepMediaUpdateInput {
  type: MediaType;
  assetId?: string | null;
}

/**
 * Identifies one TaskStep for deletion, located by (taskId, stepId) — the storage SK is
 * STEP#<stepId>. Deleting a step also cleans up every media asset attached to it (see the
 * tasks handler).
 */
export interface DeleteTaskStepInput {
  taskId: string;
  stepId: string;
}

/** One step's target position in a whole-task reorder. */
export interface ReorderTaskStepInput {
  stepId: string;
  order: number;
}

/**
 * Atomically reorder ALL of a task's steps. `steps` must be the complete current set:
 * every existing stepId exactly once, orders a contiguous 1..N permutation. Applied in a
 * single DynamoDB transaction (all-or-nothing); only the `order` attribute changes.
 */
export interface ReorderTaskStepsInput {
  taskId: string;
  steps: ReorderTaskStepInput[];
}

/** One task's target position in a whole-owner reorder. */
export interface TaskOrderInput {
  taskId: string;
  order: number;
}

/**
 * Atomically reorder ALL of a target owner's tasks. `tasks` must be the complete current set:
 * every owned taskId exactly once, with positive, mutually-unique orders (gaps allowed).
 * Applied in a single DynamoDB transaction (all-or-nothing); only the `order` attribute
 * changes. Omitted/null `userId` ⇒ the caller; a non-self value requires SupportPerson
 * delegated access.
 */
export interface UpdateTaskOrderInput {
  /** Omitted/null ⇒ the caller. A non-self value requires SupportPerson delegated access. */
  userId?: string;
  tasks: TaskOrderInput[];
}

// ── Scheduling inputs ─────────────────────────────────────────────────────────
/**
 * Create a TaskAssignment (the schedule rule). Validates the source Task exists but does
 * NOT create any TaskInstance rows. ONE_TIME requires `scheduledFor` + `timezone`;
 * RECURRING requires `scheduleRule` + `startDate` + `startTime` + `timezone`.
 */
export interface CreateTaskAssignmentInput {
  taskId: string;
  userId: string;
  assignedBy?: string;
  scheduleType: TaskAssignmentScheduleType;
  scheduledFor?: string;
  scheduleRule?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  timezone: string;
}

/**
 * Materialize one occurrence: verify (assignmentId, scheduledDate, scheduledTime) is a valid
 * occurrence of the assignment, create the TaskInstance (status IN_PROGRESS) and snapshot the
 * current TaskSteps if it doesn't exist yet. Idempotent when the instance already exists.
 */
export interface StartTaskInstanceInput {
  userId: string;
  assignmentId: string;
  scheduledDate: string;
  scheduledTime: string;
}

/**
 * Toggle one TaskInstanceStep's completion on an existing, non-terminal instance. Completing the
 * step that is currently active first closes its timer and accumulates its active seconds.
 */
export interface SetTaskInstanceStepCompletionInput {
  userId: string;
  instanceId: string;
  stepId: string;
  completed: boolean;
}

/**
 * Start (or switch to) one step's timer on a non-terminal instance. Server time only — no client
 * duration. Idempotent when the step is already active; switching from a different active step
 * first closes it and accumulates its active seconds.
 */
export interface StartTaskInstanceStepInput {
  userId: string;
  instanceId: string;
  stepId: string;
}

/**
 * Pause an instance's active-step timer (app backgrounded, task page left, screen locked, or
 * manual pause): close the active step, accumulate its active seconds, clear the active pointer.
 * Idempotent when nothing is active. Server time only.
 */
export interface PauseTaskInstanceTimerInput {
  userId: string;
  instanceId: string;
}

/**
 * Set a TaskInstance's status. Accepts IN_PROGRESS, COMPLETED, SKIPPED (OVERDUE is derived
 * and rejected; CANCELLED uses cancelTaskInstance). COMPLETED requires all steps completed.
 * A SKIPPED instance may be undone by setting it back to IN_PROGRESS.
 */
export interface UpdateTaskInstanceStatusInput {
  userId: string;
  instanceId: string;
  status: TaskInstanceStatus;
}

/** Cancel one occurrence — creates or updates a real TaskInstance (CANCELLED, isException). */
export interface CancelTaskInstanceInput {
  userId: string;
  assignmentId: string;
  scheduledDate: string;
  scheduledTime: string;
}

/**
 * End a TaskAssignment from `effectiveDate` onward. For RECURRING with occurrences still
 * remaining before that date, sets `endDate` to the day before; otherwise fully ends it
 * (active=false, endedAt set, activeTaskAssignmentTaskId removed).
 */
export interface EndTaskAssignmentInput {
  userId: string;
  assignmentId: string;
  effectiveDate: string;
}

/** Soft-delete a TaskAssignment: active=false, endedAt=now, activeTaskAssignmentTaskId removed. */
export interface DeleteTaskAssignmentInput {
  userId: string;
  assignmentId: string;
}

// Newly registered media is always created UNATTACHED — there is no stepId here; an asset
// is bound to a step only via updateTaskStep(media) (or used as a cover image).
export interface CreateMediaAssetInput {
  taskId: string;
  s3Key: string;
  type: MediaType;
  mimeType: string;
  /**
   * Deprecated/ignored. The asset owner is derived from the task's authoritative `ownerId`
   * (never client-supplied), so a SupportPerson registering media under a delegated primary
   * user's task stores that primary user as the owner. Retained only for input compatibility.
   */
  ownerId?: string;
  size?: number;
}

export interface CreateMediaUploadUrlInput {
  taskId: string;
  contentType: string;
  fileName?: string;
}

// Cover-image upload URL: no taskId (a task may not exist yet at create time). The
// returned s3Key is a server-owned pending key; the client PUTs bytes to the URL, then
// passes the key as coverImageS3Key to createTask/updateTask.
export interface CreateTaskCoverImageUploadUrlInput {
  contentType: string;
  fileName?: string;
}

// Identifies one MediaAsset for deletion (its binary + metadata row + dangling refs).
export interface DeleteMediaAssetInput {
  taskId: string;
  assetId: string;
}

// Returned by createMediaUploadUrl: a presigned PUT URL the client uploads the
// binary to, plus the s3Key to pass back to createMediaAsset once the upload lands.
export interface MediaUploadTarget {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

// Returned by getMediaDownloadUrl: a short-lived presigned GET URL for a private
// media object (the bucket blocks public access).
export interface MediaDownloadTarget {
  downloadUrl: string;
  s3Key: string;
  expiresIn: number;
}

// Cognito User Pool identity AppSync passes to a Lambda resolver. `groups` is the
// caller's Cognito groups surfaced as a top-level array; the raw claim lives under
// claims['cognito:groups'].
export interface AppSyncIdentity {
  sub?: string;
  username?: string;
  groups?: string[] | null;
  claims?: Record<string, unknown>;
  sourceIp?: string[];
}

// Shape of the AppSync event passed to Lambda resolvers. `info.fieldName` lets a
// single Lambda back several fields of one domain (routing on the resolved field).
export interface AppSyncEvent<TArgs = Record<string, unknown>> {
  arguments: TArgs;
  identity?: AppSyncIdentity;
  source?: unknown;
  info?: {
    fieldName: string;
    parentTypeName?: string;
  };
  request?: {
    headers: Record<string, string>;
  };
}

// A paginated list result (mirrors the GraphQL *Connection types). `nextToken` is an opaque,
// query-owned cursor (often a base64-encoded DynamoDB key); null when there are no more pages.
export interface Connection<T> {
  items: T[];
  nextToken: string | null;
}

// ── Admin (SystemAdmin-only) ──────────────────────────────────────────────────
// The base business role an admin assigns. Values are identical to UserRole (so the
// projection onto UserProfile.role needs no remapping); SystemAdmin is deliberately NOT
// one of these — it's an elevated group, not a base role.
export type AdminBaseRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';

export interface InviteUserInput {
  email: string;
  displayName?: string;
  organizationId?: string;
}

export interface SetUserBaseRoleInput {
  /** App-level userId — the Cognito `sub`. */
  userId: string;
  role: AdminBaseRole;
}

export interface SetSystemAdminInput {
  /** App-level userId — the Cognito `sub`. */
  userId: string;
  enabled: boolean;
}

export interface AdminDeleteUserInput {
  /** App-level userId — the Cognito `sub`. */
  userId: string;
  /** Default true: also delete the Cognito user after data cleanup succeeds. */
  deleteCognitoUser?: boolean;
  /** Default true: AdminDisableUser before data deletion (only when deleteCognitoUser). */
  disableFirst?: boolean;
}

/** Result of an admin user mutation: the user's id, email, current groups, and profile (if any). */
export interface AdminUserResult {
  userId: string;
  email?: string;
  groups: string[];
  profile?: UserProfile | null;
}

/** Tally returned by adminDeleteUser. */
export interface AdminDeleteUserResult {
  userId: string;
  deletedTasks: number;
  deletedUserItems: number;
  deletedSupportLinks: number;
  deletedCognitoUser: boolean;
}

// ── Admin organization management (SystemAdmin-only) ──────────────────────────
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

/**
 * Admin sets/clears ANOTHER user's organization membership (SystemAdmin-only — distinct from the
 * self-only updateMyUserProfile). `organizationId`: a non-null id joins that org (must exist and not
 * be deleting); explicit `null` clears membership. The field is required at runtime so omitted values
 * cannot accidentally clear a user's org. Membership rows are kept in step atomically; a real
 * org change also rotates/clears the internal membership session and revokes affected links.
 */
export interface AdminSetUserOrganizationInput {
  userId: string;
  organizationId: string | null;
}

/** Result of adminDeleteOrganization: the removed org plus how many members were detached. */
export interface AdminDeleteOrganizationResult {
  organization: Organization;
  removedUsers: number;
}

/**
 * Full read-only snapshot of everything one user owns, for the SystemAdmin user-detail
 * view: their profile, owned tasks, categories, task assignments, and support links (in
 * either direction). Gathered with PK queries + GSIs (no Scan).
 */
export interface AdminUserData {
  userId: string;
  profile?: UserProfile | null;
  tasks: Task[];
  categories: Category[];
  taskAssignments: TaskAssignment[];
  supportLinks: SupportLink[];
}

// Step generation: a task query in, ordered source-cited steps out
export interface QueryContext {
  role?: string;
  organizationId?: string;
}

export interface GenerateTaskStepsInput {
  userId: string;
  query: string;
  context?: QueryContext;
}

export interface Citation {
  chunkId: string;
  title: string;
  url?: string;
  snippet?: string;
}

// An AI-generated step (Bedrock KB + RAG output) — distinct from the persisted
// TaskStep entity above; this one carries source citations, not storage metadata.
export interface GeneratedStep {
  text: string;
  citations: Citation[];
}

export interface TaskStepsResponse {
  steps: GeneratedStep[];
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

// createAiTask PREVIEW response: an AI-generated title + ordered steps. Nothing is
// persisted — no taskId/ownerId/categoryId/timestamps and no step ids; the caller saves
// it later via createTask if they keep it. `citations` carry the resolved corpus sources
// (empty for ungrounded fallback output).
export interface GeneratedAiTaskStep {
  text: string;
  citations: Citation[];
}

export interface GeneratedAiTask {
  title: string;
  steps: GeneratedAiTaskStep[];
  /**
   * Whether the steps are grounded in the guidance corpus. true = built from retrieved
   * sources; false = ungrounded fallback generated from the model's general knowledge.
   * The frontend renders an "AI-generated, not from our guidance" notice when false.
   */
  grounded: boolean;
  /** Where the result came from — CORPUS (grounded) or UNGROUNDED_AI (fallback). */
  source: AiTaskGenerationSource;
  inputTokens?: number;
  outputTokens?: number;
}

// A passage returned by KB.Retrieve, normalized for prompt-building + citation resolution
export interface RetrievedPassage {
  chunkId: string;
  text: string;
  title: string;
  url?: string;
}

// ── AI Progress Report ──────────────────────────────────────────────────────

/** Input for generateReport: which user + inclusive date range (YYYY-MM-DD). */
export interface GenerateReportInput {
  userId: string;
  from: string;
  to: string;
}

/**
 * A freshly generated, UNSAVED report (the GraphQL GeneratedReport type). generateReport
 * computes the stats + narrative in memory and returns them inline alongside a server-signed
 * `draftToken`; nothing is written until saveReport re-submits this content with the token.
 * `scope`/`dateRange`/`stats` are plain objects — AppSync serializes them to AWSJSON on the
 * way out (same convention as accessibilitySettings / permissions).
 */
export interface GeneratedReport {
  draftToken: string;
  scope: { userId: string };
  dateRange: { from: string; to: string };
  generatedAt: string;
  narrative: string;
  stats: ReportStats;
}

/**
 * Input for saveReport: the exact content returned by a prior generateReport, plus its signed
 * `draftToken`. The server recomputes a canonical hash of this content and verifies it against
 * the token — a stale, expired, or tampered draft is rejected. `scope`/`dateRange`/`stats`
 * arrive as AWSJSON, i.e. already-parsed objects when they reach the Lambda.
 */
export interface SaveReportInput {
  draftToken: string;
  scope: { userId: string };
  dateRange: { from: string; to: string };
  generatedAt: string;
  narrative: string;
  stats: ReportStats;
}

/**
 * Optional filters for the SupportPerson's cross-user saved-report feed.
 *
 * `createdFrom` / `createdTo` filter the time the report was SAVED, not the task-history
 * coverage held in `Report.dateRange`. They are exact ISO-8601 instants (GraphQL AWSDateTime);
 * the web client turns local date-picker boundaries into UTC instants before calling the API.
 */
export interface SupportedReportFilterInput {
  /** Restrict the feed to one currently supported primary user. */
  userId?: string;
  /** Inclusive lower bound on Report.createdAt. */
  createdFrom?: string;
  /** Inclusive upper bound on Report.createdAt. */
  createdTo?: string;
}

/**
 * A persisted report's metadata row (the GraphQL Report type). Only saveReport produces one, so
 * `s3Key` is always set. `scope` and `dateRange` are plain objects — AppSync serializes them to
 * AWSJSON on the way out, the same convention used for accessibilitySettings (UserProfile) and
 * permissions (SupportLink).
 */
export interface Report {
  reportId: string;
  scope: { userId: string };
  dateRange: { from: string; to: string };
  /** The S3 key of the saved JSON document (always set — a Report row only exists once saved). */
  s3Key?: string;
  createdBy: string;
  createdAt: string;
  /** Echoed inline on the saveReport response; absent on listReports index rows. */
  narrative?: string;
  stats?: ReportStats;
}

/** Deterministic statistics computed over a user's task instances in a date range. */
export interface ReportStats {
  meta: {
    userId: string;
    from: string;
    to: string;
    /** Rates cover attempted (acted-on) instances only — recurrence is not expanded. */
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
  trend: Array<{ weekStart: string; completed: number; total: number; completionRate: number }>;
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
  /** Per-step average ACTIVE seconds (server-measured; pauses excluded). */
  stepDwell: Array<{
    taskId: string;
    title: string;
    stepOrder: number;
    stepText: string;
    samples: number;
    avgSeconds: number;
  }>;
  /** Instance-level active time per task + overall active÷wall-clock ratio. */
  focus: {
    byTask: Array<{ taskId: string; title: string; samples: number; avgActiveSeconds: number }>;
    focusRatio: number | null;
  };
  skipPatterns: {
    byTask: Array<{ taskId: string; title: string; skipped: number }>;
    byHour: number[];
  };
  abandonment: Array<{
    instanceId: string;
    taskId: string;
    title: string;
    stalledAtStepOrder: number | null;
  }>;
  timeOfDay: number[];
}

/** The full report JSON stored in S3: stats + the AI narrative. */
export interface ReportDocument {
  reportId: string;
  scope: { userId: string };
  dateRange: { from: string; to: string };
  createdBy: string;
  createdAt: string;
  stats: ReportStats;
  narrative: string;
}

/** Everything computeReportStats needs, gathered by the storage/metrics query layer. */
export interface ReportComputeInput {
  userId: string;
  from: string;
  to: string;
  now: string;
  instances: TaskInstance[];
  steps: TaskInstanceStep[];
  tasks: Task[];
  categories: Category[];
}
