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
  order
  description
  coverImageAssetId
  createdAt
  updatedAt
`;

const TASK_STEP_FIELDS = `
  stepId
  taskId
  order
  text
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

const TASK_INSTANCE_VIEW_FIELDS = `
  instanceId
  assignmentId
  taskId
  userId
  title
  scheduledDate
  scheduledTime
  scheduledFor
  timezone
  status
  isVirtual
  isException
`;

// ── Queries ──────────────────────────────────────────────────────────────────────
export const GET_USER_PROFILE = /* GraphQL */ `
  query GetUserProfile($userId: ID!) {
    getUserProfile(userId: $userId) {
      ${USER_PROFILE_FIELDS}
    }
  }
`;

/** The caller's currently effective support relationships (ACTIVE, current membership). */
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

/** One task template. Readable by its owner or a delegated/assigned reader. */
export const GET_TASK = /* GraphQL */ `
  query GetTask($taskId: ID!) {
    getTask(taskId: $taskId) {
      ${TASK_FIELDS}
    }
  }
`;

/** A task's steps sorted by ascending order (same read access as getTask). */
export const LIST_TASK_STEPS = /* GraphQL */ `
  query ListTaskSteps($taskId: ID!, $limit: Int, $nextToken: String) {
    listTaskSteps(taskId: $taskId, limit: $limit, nextToken: $nextToken) {
      items {
        ${TASK_STEP_FIELDS}
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

/** Virtual schedule occurrences overlaid with any real TaskInstance rows in the date window. */
export const GET_TASK_INSTANCE_VIEWS = /* GraphQL */ `
  query GetTaskInstanceViews($userId: ID!, $startDate: String!, $endDate: String!) {
    getTaskInstanceViews(userId: $userId, startDate: $startDate, endDate: $endDate) {
      items {
        ${TASK_INSTANCE_VIEW_FIELDS}
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

// ── Task-template mutations (SupportPerson-owned templates) ──────────────────────
/**
 * Create a task template owned by the CALLER. The portal never sends `input.userId`, so
 * the returned ownerId is always the authenticated SupportPerson's sub. The response echoes
 * the nested steps just written.
 */
export const CREATE_TASK = /* GraphQL */ `
  mutation CreateTask($input: CreateTaskInput!) {
    createTask(input: $input) {
      ${TASK_FIELDS}
      steps {
        ${TASK_STEP_FIELDS}
      }
    }
  }
`;

export const UPDATE_TASK = /* GraphQL */ `
  mutation UpdateTask($input: UpdateTaskInput!) {
    updateTask(input: $input) {
      ${TASK_FIELDS}
    }
  }
`;

/** Rejected by the backend while any ACTIVE assignment still references the task. */
export const DELETE_TASK = /* GraphQL */ `
  mutation DeleteTask($taskId: ID!) {
    deleteTask(taskId: $taskId) {
      taskId
      title
    }
  }
`;

export const CREATE_TASK_STEP = /* GraphQL */ `
  mutation CreateTaskStep($input: CreateTaskStepInput!) {
    createTaskStep(input: $input) {
      ${TASK_STEP_FIELDS}
    }
  }
`;

export const UPDATE_TASK_STEP = /* GraphQL */ `
  mutation UpdateTaskStep($input: UpdateTaskStepInput!) {
    updateTaskStep(input: $input) {
      ${TASK_STEP_FIELDS}
    }
  }
`;

export const DELETE_TASK_STEP = /* GraphQL */ `
  mutation DeleteTaskStep($input: DeleteTaskStepInput!) {
    deleteTaskStep(input: $input) {
      ${TASK_STEP_FIELDS}
    }
  }
`;

/** Atomic whole-set renumber: send every current stepId once with orders 1..N. */
export const REORDER_TASK_STEPS = /* GraphQL */ `
  mutation ReorderTaskSteps($input: ReorderTaskStepsInput!) {
    reorderTaskSteps(input: $input) {
      ${TASK_STEP_FIELDS}
    }
  }
`;

// ── Task-assignment mutations (schedule rules) ───────────────────────────────────
export const CREATE_TASK_ASSIGNMENT = /* GraphQL */ `
  mutation CreateTaskAssignment($input: CreateTaskAssignmentInput!) {
    createTaskAssignment(input: $input) {
      ${TASK_ASSIGNMENT_FIELDS}
    }
  }
`;

/** End an assignment from a date onward (shortens/ends — never extends). */
export const END_TASK_ASSIGNMENT = /* GraphQL */ `
  mutation EndTaskAssignment($input: EndTaskAssignmentInput!) {
    endTaskAssignment(input: $input) {
      ${TASK_ASSIGNMENT_FIELDS}
    }
  }
`;

/** Soft-delete an assignment (stop immediately; unblocks deleteTask on the template). */
export const DELETE_TASK_ASSIGNMENT = /* GraphQL */ `
  mutation DeleteTaskAssignment($input: DeleteTaskAssignmentInput!) {
    deleteTaskAssignment(input: $input) {
      ${TASK_ASSIGNMENT_FIELDS}
    }
  }
`;
