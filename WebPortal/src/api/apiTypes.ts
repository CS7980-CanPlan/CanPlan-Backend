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
  notificationEnabled?: boolean | null;
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

export type AssignmentStatus = 'TO_DO' | 'OVERDUE' | 'COMPLETED' | 'SKIPPED';

export interface Assignment {
  assignmentId: string;
  taskId: string;
  userId: string;
  assignedBy?: string | null;
  dueDate?: string | null;
  status: AssignmentStatus;
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
  assignments: Assignment[];
  supportLinks: SupportLink[];
}

export interface UserProfileConnection {
  items: UserProfile[];
  nextToken: string | null;
}

export interface TaskConnection {
  items: Task[];
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

// ── Pagination args ──────────────────────────────────────────────────────────────
export interface PageArgs {
  limit?: number;
  nextToken?: string | null;
}
