// Single-table key conventions for CanPlan's DynamoDB design.
//
// Every item carries a composite primary key (PK + SK) and an `entityType`
// discriminator. Centralizing the key builders here keeps the PK/SK formats in
// one place so handlers, tests, and future migrations cannot drift apart.

/** Discriminator stored on every item so a single Query can mix entity types. */
export const ENTITY = {
  USER_PROFILE: 'UserProfile',
  SUPPORT_LINK: 'SupportLink',
  TASK: 'Task',
  TASK_STEP: 'TaskStep',
  ASSIGNMENT: 'Assignment',
  PROGRESS_EVENT: 'ProgressEvent',
  MEDIA_ASSET: 'MediaAsset',
  REPORT: 'Report',
} as const;

export type EntityType = (typeof ENTITY)[keyof typeof ENTITY];

// ── Global Secondary Index names (defined in the Database construct) ──────────
export const SUPPORTER_INDEX = 'supporterIndex';
export const ORG_INDEX = 'orgIndex';
export const TASK_OWNER_INDEX = 'taskOwnerIndex';

// ── Fixed sort-key values ─────────────────────────────────────────────────────
export const PROFILE_SK = '#PROFILE';
export const META_SK = '#META';

// ── Sort-key prefixes (for begins_with queries) ──────────────────────────────
export const STEP_PREFIX = 'STEP#';
export const ASSIGN_PREFIX = 'ASSIGN#';
export const PROGRESS_PREFIX = 'PROGRESS#';
export const MEDIA_PREFIX = 'MEDIA#';
export const USER_LINK_PREFIX = 'USER#';

// ── Partition keys ────────────────────────────────────────────────────────────
export const userPk = (userId: string): string => `USER#${userId}`;
export const supporterPk = (supporterId: string): string => `SUPPORTER#${supporterId}`;
export const taskPk = (taskId: string): string => `TASK#${taskId}`;
export const reportPk = (reportId: string): string => `REPORT#${reportId}`;

// ── Sort keys ─────────────────────────────────────────────────────────────────
/** SupportLink SK — one row per managed primary user under a supporter. */
export const userLinkSk = (primaryUserId: string): string => `USER#${primaryUserId}`;
/** TaskStep SK — zero-padded order keeps steps lexicographically ordered (STEP#001). */
export const stepSk = (order: number): string => `${STEP_PREFIX}${padOrder(order)}`;
/** Assignment SK — keyed by the globally-unique assignmentId, never the taskId. */
export const assignSk = (assignmentId: string): string => `${ASSIGN_PREFIX}${assignmentId}`;
/** ProgressEvent SK — timestamp first (sortable), eventId for uniqueness. Append-only. */
export const progressSk = (timestamp: string, eventId: string): string =>
  `${PROGRESS_PREFIX}${timestamp}#${eventId}`;
/** MediaAsset SK — keyed by the unique assetId under the owning task. */
export const mediaSk = (assetId: string): string => `${MEDIA_PREFIX}${assetId}`;

/** Zero-pad a step order to three digits: 1 → "001". Keeps STEP#001 < STEP#010 < STEP#100. */
export function padOrder(order: number): string {
  return String(order).padStart(3, '0');
}
