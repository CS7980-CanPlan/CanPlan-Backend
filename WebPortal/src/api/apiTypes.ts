/**
 * Strict TypeScript types mirroring the backend AppSync admin schema
 * (graphql/schema.graphql). Inputs/results here must stay in sync with it.
 */

// ── Enums ──────────────────────────────────────────────────────────────────────
export type UserRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';
/** The base role an admin can assign (mirrors UserRole; SystemAdmin is not a base role). */
export type AdminBaseRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';

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
  description?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
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

// ── Pagination args ──────────────────────────────────────────────────────────────
export interface PageArgs {
  limit?: number;
  nextToken?: string | null;
}
