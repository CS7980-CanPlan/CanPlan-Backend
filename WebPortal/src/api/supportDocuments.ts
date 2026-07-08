/**
 * Centralized GraphQL documents for the SupportPerson portal. Kept separate from the admin
 * documents so each portal's wire format lives in one place; `supportApi.ts` references these.
 * These use the API's default Cognito auth (no SystemAdmin directive) and rely on the
 * backend's SupportPerson delegation rules for anything about a supported primary user.
 */

// Reused field selections.
const USER_PROFILE_FIELDS = `
  userId
  role
  displayName
  email
  organizationId
  defaultCategoryId
  createdAt
  updatedAt
`;

const SUPPORT_LINK_FIELDS = `
  supporterId
  primaryUserId
  userId
  status
  createdAt
  updatedAt
`;

const TASK_FIELDS = `
  taskId
  ownerId
  title
  categoryId
  description
  createdAt
  updatedAt
`;

const CATEGORY_FIELDS = `
  categoryId
  ownerId
  name
  color
  sortOrder
  isDefault
  createdAt
  updatedAt
`;

const TASK_ASSIGNMENT_FIELDS = `
  assignmentId
  taskId
  userId
  assignedBy
  scheduleType
  scheduledFor
  scheduleRule
  startDate
  endDate
  startTime
  timezone
  active
  endedAt
  assignedAt
  createdAt
  updatedAt
`;

// ── Queries ──────────────────────────────────────────────────────────────────────
export const GET_USER_PROFILE = /* GraphQL */ `
  query GetUserProfile($userId: ID!) {
    getUserProfile(userId: $userId) {
      ${USER_PROFILE_FIELDS}
    }
  }
`;

/** The caller's OWN support list (every primary user they selected — ACTIVE + REVOKED). */
export const LIST_MY_SUPPORT_LIST = /* GraphQL */ `
  query ListMySupportList($limit: Int, $nextToken: String) {
    listMySupportList(limit: $limit, nextToken: $nextToken) {
      items {
        ${SUPPORT_LINK_FIELDS}
      }
      nextToken
    }
  }
`;

/** The caller's OWN organization roster (orgIndex projection: userId, displayName, role). */
export const LIST_MY_ORGANIZATION_USERS = /* GraphQL */ `
  query ListMyOrganizationUsers($limit: Int, $nextToken: String) {
    listMyOrganizationUsers(limit: $limit, nextToken: $nextToken) {
      items {
        userId
        displayName
        role
      }
      nextToken
    }
  }
`;

export const LIST_TASKS_BY_OWNER = /* GraphQL */ `
  query ListTasksByOwner($ownerId: ID!, $limit: Int, $nextToken: String) {
    listTasksByOwner(ownerId: $ownerId, limit: $limit, nextToken: $nextToken) {
      items {
        ${TASK_FIELDS}
      }
      nextToken
    }
  }
`;

export const LIST_MY_CATEGORIES = /* GraphQL */ `
  query ListMyCategories($userId: ID, $limit: Int, $nextToken: String) {
    listMyCategories(userId: $userId, limit: $limit, nextToken: $nextToken) {
      items {
        ${CATEGORY_FIELDS}
      }
      nextToken
    }
  }
`;

export const LIST_TASK_ASSIGNMENTS_FOR_USER = /* GraphQL */ `
  query ListTaskAssignmentsForUser($userId: ID!, $limit: Int, $nextToken: String) {
    listTaskAssignmentsForUser(userId: $userId, limit: $limit, nextToken: $nextToken) {
      items {
        ${TASK_ASSIGNMENT_FIELDS}
      }
      nextToken
    }
  }
`;

// ── Mutations ────────────────────────────────────────────────────────────────────
/** Partial update of the caller's OWN profile (displayName / organizationId / settings). */
export const UPDATE_MY_USER_PROFILE = /* GraphQL */ `
  mutation UpdateMyUserProfile($input: UpdateMyUserProfileInput!) {
    updateMyUserProfile(input: $input) {
      ${USER_PROFILE_FIELDS}
    }
  }
`;

export const SELECT_PRIMARY_USER = /* GraphQL */ `
  mutation SelectPrimaryUser($input: SelectPrimaryUserInput!) {
    selectPrimaryUser(input: $input) {
      ${SUPPORT_LINK_FIELDS}
    }
  }
`;

export const UNSELECT_PRIMARY_USER = /* GraphQL */ `
  mutation UnselectPrimaryUser($input: UnselectPrimaryUserInput!) {
    unselectPrimaryUser(input: $input) {
      ${SUPPORT_LINK_FIELDS}
    }
  }
`;
