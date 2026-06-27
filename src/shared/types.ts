// Core domain types shared across Lambda functions.
//
// Entity interfaces mirror the GraphQL output types (domain fields only — the
// PK/SK/entityType key attributes are added at write time, see src/shared/keys.ts).

// ── Enums (mirror graphql/schema.graphql) ─────────────────────────────────────
export type UserRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';
export type SupportLinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';
/**
 * Assignment status as surfaced through the API. `OVERDUE` is derived at read time
 * (persisted status TO_DO + a dueDate in the past) — it is never written to storage.
 */
export type AssignmentStatus = 'TO_DO' | 'OVERDUE' | 'COMPLETED' | 'SKIPPED';
/** The only statuses ever persisted on an Assignment row. */
export type PersistedAssignmentStatus = 'TO_DO' | 'COMPLETED' | 'SKIPPED';
export type MediaType = 'IMAGE' | 'AUDIO' | 'VIDEO';
export type RepeatUnit = 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH';

// ── Entities ──────────────────────────────────────────────────────────────────
export interface UserProfile {
  userId: string;
  role: UserRole;
  displayName?: string;
  email?: string;
  organizationId?: string;
  accessibilitySettings?: Record<string, unknown>;
  /**
   * Id of this user's mandatory default Category (a real Category row with
   * `isDefault: true`). Written atomically with the profile and never null for a
   * profile created/migrated under the current model; Tasks created without an
   * explicit category fall into it.
   */
  defaultCategoryId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SupportLink {
  supporterId: string;
  primaryUserId: string;
  /** Mirror of primaryUserId — the supporterIndex sort key. */
  userId: string;
  status: SupportLinkStatus;
  permissions?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
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

/** Recurring-schedule metadata persisted on a Task (phase 1 stores it; delivery is later). */
export interface TaskSchedule {
  repeatEvery: number;
  repeatUnit: RepeatUnit;
  firstOccurrenceAt: string;
  timezone: string;
  enabled: boolean;
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
  scheduleRule?: string;
  /** Recurring-schedule metadata; present only when the task was created with a schedule. */
  schedule?: TaskSchedule;
  /** First (next) fire time — equals schedule.firstOccurrenceAt at creation. */
  nextOccurrenceAt?: string;
  /** Whether reminders are enabled; defaults to true when a schedule is provided. */
  notificationEnabled?: boolean;
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

export interface Assignment {
  assignmentId: string;
  taskId: string;
  userId: string;
  assignedBy?: string;
  dueDate?: string;
  recurrence?: string;
  scheduleRule?: string;
  /** Persisted as TO_DO/COMPLETED/SKIPPED; surfaced as AssignmentStatus (may be OVERDUE). */
  status: AssignmentStatus;
  assignedAt: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * A snapshot of one TaskStep captured into one Assignment at creation time. The
 * snapshot is immutable to template edits — later changes to the Task's steps must
 * not alter historical assignments. PK = USER#<userId>, SK = ASSIGN_STEP#<assignmentId>#STEP#<stepId>.
 *
 * Carries text/completion only — NOT media. A live Task MediaAsset can be deleted with
 * its TaskStep, so it is never copied here. Assignment-visible media, if ever needed,
 * must be a separate assignment-owned snapshot.
 */
export interface AssignmentStep {
  assignmentId: string;
  taskId: string;
  stepId: string;
  order: number;
  text: string;
  completed: boolean;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
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
 * organizationId, defaultCategoryId, and timestamps are intentionally absent: they cannot
 * be changed here. At least one of `displayName`/`accessibilitySettings` must be supplied.
 * `displayName`: omitted ⇒ unchanged; otherwise trimmed and may not be empty/whitespace.
 * `accessibilitySettings`: omitted ⇒ unchanged; explicit `null` ⇒ cleared; a non-null value
 * ⇒ FULL replacement of the stored settings (never deep-merged).
 */
export interface UpdateMyUserProfileInput {
  displayName?: string | null;
  accessibilitySettings?: Record<string, unknown> | null;
}

export interface CreateSupportLinkInput {
  supporterId: string;
  primaryUserId: string;
  status?: SupportLinkStatus;
  permissions?: Record<string, unknown>;
}

// ownerId is intentionally absent — the owner is derived from the authenticated
// Cognito identity (event.identity.sub), never client-supplied. Categories are private
// to their owner.
export interface CreateCategoryInput {
  name: string;
  color?: string;
  sortOrder?: number;
}

/**
 * Partial edit of one of the caller's own categories. At least one updatable field
 * (name, color, sortOrder) must be supplied. The default category's `name` may not be
 * changed (color/sortOrder are allowed); a normal category may not be renamed to the
 * reserved default name.
 */
export interface UpdateCategoryInput {
  categoryId: string;
  name?: string;
  color?: string;
  sortOrder?: number;
}

/** Identifies one of the caller's own categories to delete. The default cannot be deleted. */
export interface DeleteCategoryInput {
  categoryId: string;
}

export interface CreateTaskStepNestedInput {
  text: string;
  /** Optional longer description, separate from `text`. Trimmed when stored. */
  description?: string;
}

/** Schedule metadata accepted at task creation. `enabled` defaults to true when stored. */
export interface TaskScheduleInput {
  repeatEvery: number;
  repeatUnit: RepeatUnit;
  firstOccurrenceAt: string;
  timezone: string;
  enabled?: boolean;
}

// ownerId is intentionally absent — the owner is derived from the authenticated
// Cognito identity (event.identity.sub), never client-supplied.
export interface CreateTaskInput {
  title: string;
  /**
   * Optional. Omitted/null ⇒ the owner's default category. A blank string is rejected.
   * A supplied id must be a real, owned, non-deleting Category.
   */
  categoryId?: string;
  description?: string;
  scheduleRule?: string;
  steps?: CreateTaskStepNestedInput[];
  schedule?: TaskScheduleInput;
  notificationEnabled?: boolean;
  /**
   * Optional cover image: the pending s3Key returned by createTaskCoverImageUploadUrl
   * (after the client PUT the bytes). Omitted ⇒ no cover image.
   */
  coverImageS3Key?: string;
}

// AI one-shot task creation input: one free-text request (+ optional category).
export interface CreateAiTaskInput {
  query: string;
  categoryId?: string;
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
  scheduleRule?: string;
  schedule?: TaskScheduleInput;
  notificationEnabled?: boolean;
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

export interface CreateAssignmentInput {
  taskId: string;
  userId: string;
  assignedBy?: string;
  dueDate?: string;
  recurrence?: string;
  scheduleRule?: string;
}

export interface UpdateAssignmentStatusInput {
  userId: string;
  assignmentId: string;
  /** Accepts the AssignmentStatus enum, but OVERDUE is rejected — it is a derived status. */
  status: AssignmentStatus;
}

export interface SetAssignmentStepCompletionInput {
  userId: string;
  assignmentId: string;
  stepId: string;
  completed: boolean;
}

/**
 * Identifies one Assignment for deletion by its composite key (userId + assignmentId).
 * Deleting an assignment also removes all of its AssignmentStep snapshots; the source
 * Task and its TaskSteps are never touched.
 */
export interface DeleteAssignmentInput {
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
  ownerId: string;
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

// A paginated list result (mirrors the GraphQL *Connection types). `nextToken` is an
// opaque, base64-encoded DynamoDB LastEvaluatedKey; null when there are no more pages.
export interface Connection<T> {
  items: T[];
  nextToken: string | null;
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

// createAiTask PREVIEW response: an AI-generated title + ordered, text-only steps.
// Nothing is persisted — no taskId/ownerId/categoryId/timestamps and no step ids or
// citations; the caller saves it later via createTask if they keep it.
export interface GeneratedAiTaskStep {
  text: string;
}

export interface GeneratedAiTask {
  title: string;
  steps: GeneratedAiTaskStep[];
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
