// Single-table key conventions for CanPlan's DynamoDB design.
//
// Every item carries a composite primary key (PK + SK) and an `entityType`
// discriminator. Centralizing the key builders here keeps the PK/SK formats in
// one place so handlers, tests, and future migrations cannot drift apart.

/** Discriminator stored on every item so a single Query can mix entity types. */
export const ENTITY = {
  USER_PROFILE: 'UserProfile',
  SUPPORT_LINK: 'SupportLink',
  ORGANIZATION: 'Organization',
  CATEGORY: 'Category',
  TASK: 'Task',
  TASK_STEP: 'TaskStep',
  ASSIGNMENT: 'Assignment',
  ASSIGNMENT_STEP: 'AssignmentStep',
  MEDIA_ASSET: 'MediaAsset',
  TASK_MEDIA_CLEANUP: 'TaskMediaCleanup',
  REPORT: 'Report',
} as const;

export type EntityType = (typeof ENTITY)[keyof typeof ENTITY];

// ── Global Secondary Index names (defined in the Database construct) ──────────
export const SUPPORTER_INDEX = 'supporterIndex';
export const ORG_INDEX = 'orgIndex';
export const TASK_OWNER_INDEX = 'taskOwnerIndex';
// Tasks within one owner's category, newest-sortable by createdAt. Keyed on the
// denormalized `taskCategoryKey` (<ownerId>#<categoryId>) so a single Query scopes
// to both owner and category. Sparse: only Task items carry taskCategoryKey.
export const TASK_CATEGORY_INDEX = 'taskCategoryIndex';
// General-purpose index keyed by entityType — backs SystemAdmin/admin listing APIs
// (list-all-by-type) without scanning the table. Every item carries entityType +
// createdAt, so all entities are queryable by type, newest-first.
export const ENTITY_TYPE_INDEX = 'entityTypeIndex';

// ── Fixed sort-key values ─────────────────────────────────────────────────────
export const PROFILE_SK = '#PROFILE';
export const META_SK = '#META';

// ── Sort-key prefixes (for begins_with queries) ──────────────────────────────
export const CATEGORY_PREFIX = 'CATEGORY#';
export const STEP_PREFIX = 'STEP#';
export const ASSIGN_PREFIX = 'ASSIGN#';
// AssignmentStep snapshots. Note `ASSIGN_STEP#` does NOT begin with `ASSIGN#`
// (the 7th char is `_`, not `#`), so a begins_with(SK, 'ASSIGN#') query for a
// user's assignments never returns these step rows.
export const ASSIGN_STEP_PREFIX = 'ASSIGN_STEP#';
export const MEDIA_PREFIX = 'MEDIA#';
// Durable journal rows used while cascading a Task's media deletion. They retain the
// S3 key across retries even after the MediaAsset row has been removed.
export const TASK_MEDIA_CLEANUP_PREFIX = 'CLEANUP_MEDIA#';
export const USER_LINK_PREFIX = 'USER#';

// ── Reserved category ─────────────────────────────────────────────────────────
/**
 * Name of every user's mandatory default Category. It is a real, persisted Category
 * row (its own generated UUID, `isDefault: true`) — not a synthetic fallback id. A Task created
 * without an explicit category falls into its owner's default category, and the
 * default category can be neither renamed nor deleted. Creating another category with
 * this name for the same owner is rejected so the reserved one stays unambiguous.
 */
export const DEFAULT_CATEGORY_NAME = 'No Category';
/** Neutral slate color assigned when the server creates a default Category. */
export const DEFAULT_CATEGORY_COLOR = '#64748B';

/** True when `name` (trimmed, case-insensitive) collides with the reserved default name. */
export function isDefaultCategoryName(name: string): boolean {
  return name.trim().toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase();
}

// ── Partition keys ────────────────────────────────────────────────────────────
export const userPk = (userId: string): string => `USER#${userId}`;
export const supporterPk = (supporterId: string): string => `SUPPORTER#${supporterId}`;
export const taskPk = (taskId: string): string => `TASK#${taskId}`;
export const reportPk = (reportId: string): string => `REPORT#${reportId}`;

// ── GSI partition keys (denormalized onto items at write time) ────────────────
/**
 * taskCategoryIndex partition key — scopes a Task to both its owner and category in
 * one composite so listTasksByCategory needs neither a filter nor a second key.
 */
export const taskCategoryKey = (ownerId: string, categoryId: string): string =>
  `${ownerId}#${categoryId}`;

// ── Sort keys ─────────────────────────────────────────────────────────────────
/** Category SK — one row per category under its owning user (PK = USER#<ownerId>). */
export const categorySk = (categoryId: string): string => `${CATEGORY_PREFIX}${categoryId}`;
/** SupportLink SK — one row per managed primary user under a supporter. */
export const userLinkSk = (primaryUserId: string): string => `USER#${primaryUserId}`;
/**
 * TaskStep SK — keyed by the stable, immutable stepId (STEP#<stepId>), NOT by `order`.
 * `order` is a plain item attribute, so a step can be reordered with a single in-place
 * attribute update (no key rewrite), and a whole-task reorder is one atomic transaction.
 * Read paths sort by the numeric `order` attribute, never by key order.
 */
export const stepSk = (stepId: string): string => `${STEP_PREFIX}${stepId}`;
/** Assignment SK — keyed by the globally-unique assignmentId, never the taskId. */
export const assignSk = (assignmentId: string): string => `${ASSIGN_PREFIX}${assignmentId}`;
/** AssignmentStep SK — one snapshot row per TaskStep within one assignment. */
export const assignStepSk = (assignmentId: string, stepId: string): string =>
  `${ASSIGN_STEP_PREFIX}${assignmentId}#${STEP_PREFIX}${stepId}`;
/** begins_with prefix to query only one assignment's step snapshots. */
export const assignStepPrefix = (assignmentId: string): string =>
  `${ASSIGN_STEP_PREFIX}${assignmentId}#${STEP_PREFIX}`;
/** MediaAsset SK — keyed by the unique assetId under the owning task. */
export const mediaSk = (assetId: string): string => `${MEDIA_PREFIX}${assetId}`;
/** Task-media cleanup journal SK — retains an S3 key until the binary is deleted. */
export const taskMediaCleanupSk = (assetId: string): string =>
  `${TASK_MEDIA_CLEANUP_PREFIX}${assetId}`;
