/**
 * Centralized GraphQL documents for the admin portal. All operations live here so the
 * wire format is defined in exactly one place; `adminApi.ts` references these by name.
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

const TASK_FIELDS = `
  taskId
  ownerId
  title
  categoryId
  description
  notificationEnabled
  createdAt
  updatedAt
`;

const ADMIN_USER_RESULT_FIELDS = `
  userId
  email
  groups
  profile {
    ${USER_PROFILE_FIELDS}
  }
`;

// ── Queries ──────────────────────────────────────────────────────────────────────
export const LIST_ALL_USERS = /* GraphQL */ `
  query ListAllUsers($limit: Int, $nextToken: String) {
    listAllUsers(limit: $limit, nextToken: $nextToken) {
      items {
        ${USER_PROFILE_FIELDS}
      }
      nextToken
    }
  }
`;

export const LIST_ALL_TASKS = /* GraphQL */ `
  query ListAllTasks($limit: Int, $nextToken: String) {
    listAllTasks(limit: $limit, nextToken: $nextToken) {
      items {
        ${TASK_FIELDS}
      }
      nextToken
    }
  }
`;

export const ADMIN_GET_USER_DATA = /* GraphQL */ `
  query AdminGetUserData($userId: ID!) {
    adminGetUserData(userId: $userId) {
      userId
      profile {
        ${USER_PROFILE_FIELDS}
      }
      tasks {
        ${TASK_FIELDS}
      }
      categories {
        categoryId
        ownerId
        name
        color
        sortOrder
        isDefault
        createdAt
        updatedAt
      }
      assignments {
        assignmentId
        taskId
        userId
        assignedBy
        dueDate
        status
        assignedAt
        createdAt
        updatedAt
      }
      supportLinks {
        supporterId
        primaryUserId
        userId
        status
        createdAt
        updatedAt
      }
    }
  }
`;

// ── Mutations ────────────────────────────────────────────────────────────────────
export const INVITE_SUPPORT_PERSON = /* GraphQL */ `
  mutation InviteSupportPerson($input: InviteUserInput!) {
    inviteSupportPerson(input: $input) {
      ${ADMIN_USER_RESULT_FIELDS}
    }
  }
`;

export const INVITE_ORGANIZATION_ADMIN = /* GraphQL */ `
  mutation InviteOrganizationAdmin($input: InviteUserInput!) {
    inviteOrganizationAdmin(input: $input) {
      ${ADMIN_USER_RESULT_FIELDS}
    }
  }
`;

export const SET_USER_BASE_ROLE = /* GraphQL */ `
  mutation SetUserBaseRole($input: SetUserBaseRoleInput!) {
    setUserBaseRole(input: $input) {
      ${ADMIN_USER_RESULT_FIELDS}
    }
  }
`;

export const SET_SYSTEM_ADMIN = /* GraphQL */ `
  mutation SetSystemAdmin($input: SetSystemAdminInput!) {
    setSystemAdmin(input: $input) {
      ${ADMIN_USER_RESULT_FIELDS}
    }
  }
`;

export const ADMIN_DELETE_TASK = /* GraphQL */ `
  mutation AdminDeleteTask($taskId: ID!) {
    adminDeleteTask(taskId: $taskId) {
      ${TASK_FIELDS}
    }
  }
`;

export const ADMIN_DELETE_USER = /* GraphQL */ `
  mutation AdminDeleteUser($input: AdminDeleteUserInput!) {
    adminDeleteUser(input: $input) {
      userId
      deletedTasks
      deletedUserItems
      deletedSupportLinks
      deletedCognitoUser
    }
  }
`;
