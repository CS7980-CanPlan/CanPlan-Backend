/**
 * Raw SupportPerson API functions — one per GraphQL operation, framework-agnostic (no React).
 * React Query hooks in `supportHooks.ts` wrap these; components never call gqlRequest directly.
 */
import type {
  CategoryConnection,
  CreateAiTaskInput,
  CreateTaskAssignmentInput,
  CreateTaskInput,
  CreateTaskStepInput,
  DeleteTaskAssignmentInput,
  DeleteTaskStepInput,
  EndTaskAssignmentInput,
  GeneratedAiTask,
  PageArgs,
  ReorderTaskStepsInput,
  SelectPrimaryUserInput,
  SupportLink,
  SupportLinkConnection,
  Task,
  TaskAssignment,
  TaskAssignmentConnection,
  TaskConnection,
  TaskInstance,
  TaskInstanceConnection,
  TaskInstanceStep,
  TaskInstanceStepConnection,
  TaskInstanceViewConnection,
  TaskStep,
  TaskStepConnection,
  UnselectPrimaryUserInput,
  UpdateMyUserProfileInput,
  UpdateTaskInput,
  UpdateTaskStepInput,
  UserProfile,
  UserProfileConnection,
} from './apiTypes';
import { gqlRequest } from './graphqlClient';
import {
  CREATE_AI_TASK,
  CREATE_TASK,
  CREATE_TASK_ASSIGNMENT,
  CREATE_TASK_STEP,
  DELETE_TASK,
  DELETE_TASK_ASSIGNMENT,
  DELETE_TASK_STEP,
  END_TASK_ASSIGNMENT,
  GET_TASK_INSTANCE,
  GET_TASK_INSTANCE_VIEWS,
  GET_TASK,
  GET_USER_PROFILE,
  LIST_MY_CATEGORIES,
  LIST_MY_ORGANIZATION_USERS,
  LIST_MY_SUPPORT_LIST,
  LIST_TASK_ASSIGNMENTS_FOR_USER,
  LIST_TASK_INSTANCES,
  LIST_TASK_INSTANCE_STEPS,
  LIST_TASK_STEPS,
  LIST_TASKS_BY_OWNER,
  REORDER_TASK_STEPS,
  SELECT_PRIMARY_USER,
  UNSELECT_PRIMARY_USER,
  UPDATE_MY_USER_PROFILE,
  UPDATE_TASK,
  UPDATE_TASK_STEP,
} from './supportDocuments';

// ── Queries ──────────────────────────────────────────────────────────────────────
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const data = await gqlRequest<{ getUserProfile: UserProfile | null }>(GET_USER_PROFILE, {
    userId,
  });
  return data.getUserProfile;
}

export async function listMySupportList(args: PageArgs = {}): Promise<SupportLinkConnection> {
  const data = await gqlRequest<{ listMySupportList: SupportLinkConnection }>(
    LIST_MY_SUPPORT_LIST,
    {
      limit: args.limit,
      nextToken: args.nextToken ?? null,
    },
  );
  return data.listMySupportList;
}

/**
 * Drain EVERY page of the caller's effective support list. The backend filters stale links
 * after each DynamoDB page, so a sparse early page can still be followed by effective users.
 */
export async function listAllMySupportList(): Promise<SupportLink[]> {
  const links: SupportLink[] = [];
  let nextToken: string | null = null;
  do {
    const page: SupportLinkConnection = await listMySupportList({ limit: 100, nextToken });
    links.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return links;
}

export async function listMyOrganizationUsers(args: PageArgs = {}): Promise<UserProfileConnection> {
  const data = await gqlRequest<{ listMyOrganizationUsers: UserProfileConnection }>(
    LIST_MY_ORGANIZATION_USERS,
    { limit: args.limit, nextToken: args.nextToken ?? null },
  );
  return data.listMyOrganizationUsers;
}

/** Drain EVERY page of the caller's organization roster (candidate pickers + name lookups). */
export async function listAllMyOrganizationUsers(): Promise<UserProfile[]> {
  const users: UserProfile[] = [];
  let nextToken: string | null = null;
  do {
    const page: UserProfileConnection = await listMyOrganizationUsers({ limit: 100, nextToken });
    users.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return users;
}

export async function listTasksByOwner(
  ownerId: string,
  args: PageArgs = {},
): Promise<TaskConnection> {
  const data = await gqlRequest<{ listTasksByOwner: TaskConnection }>(LIST_TASKS_BY_OWNER, {
    ownerId,
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listTasksByOwner;
}

export async function listMyCategories(
  userId: string,
  args: PageArgs = {},
): Promise<CategoryConnection> {
  const data = await gqlRequest<{ listMyCategories: CategoryConnection }>(LIST_MY_CATEGORIES, {
    userId,
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listMyCategories;
}

export async function listTaskAssignmentsForUser(
  userId: string,
  args: PageArgs = {},
): Promise<TaskAssignmentConnection> {
  const data = await gqlRequest<{ listTaskAssignmentsForUser: TaskAssignmentConnection }>(
    LIST_TASK_ASSIGNMENTS_FOR_USER,
    { userId, limit: args.limit, nextToken: args.nextToken ?? null },
  );
  return data.listTaskAssignmentsForUser;
}

/**
 * Read one supported user's calendar. The backend returns virtual schedule occurrences and
 * overlays real TaskInstances for the inclusive date window; it always returns one full page.
 */
export async function getTaskInstanceViews(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<TaskInstanceViewConnection> {
  const data = await gqlRequest<{ getTaskInstanceViews: TaskInstanceViewConnection }>(
    GET_TASK_INSTANCE_VIEWS,
    { userId, startDate, endDate },
  );
  return data.getTaskInstanceViews;
}

/**
 * Read one materialized instance. Supplying `userId` invokes delegated access; omitting it asks
 * the backend to resolve the authenticated caller's own partition.
 */
export async function getTaskInstance(
  userId: string | undefined,
  instanceId: string,
): Promise<TaskInstance | null> {
  const data = await gqlRequest<{ getTaskInstance: TaskInstance | null }>(GET_TASK_INSTANCE, {
    instanceId,
    userId: userId?.trim() || null,
  });
  return data.getTaskInstance;
}

/** One cursor page of real/materialized instances in an inclusive date range. */
export async function listTaskInstances(
  userId: string | undefined,
  startDate: string,
  endDate: string,
  args: PageArgs = {},
): Promise<TaskInstanceConnection> {
  const data = await gqlRequest<{ listTaskInstances: TaskInstanceConnection }>(
    LIST_TASK_INSTANCES,
    {
      userId: userId?.trim() || null,
      startDate,
      endDate,
      limit: args.limit,
      nextToken: args.nextToken ?? null,
    },
  );
  return data.listTaskInstances;
}

/**
 * Drain every materialized-instance page in the selected range. The backend caps each range at
 * 370 days; callers choose that bounded range before invoking this helper.
 */
export async function listAllTaskInstancesForUser(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<TaskInstance[]> {
  const instances: TaskInstance[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | null = null;

  do {
    const page = await listTaskInstances(userId, startDate, endDate, {
      limit: 100,
      nextToken,
    });
    instances.push(...page.items);
    nextToken = checkedNextToken('listTaskInstances', page.nextToken, seenTokens);
  } while (nextToken);

  return instances;
}

/** One cursor page of immutable step snapshots for a materialized instance. */
export async function listTaskInstanceSteps(
  userId: string,
  instanceId: string,
  args: PageArgs = {},
): Promise<TaskInstanceStepConnection> {
  const data = await gqlRequest<{ listTaskInstanceSteps: TaskInstanceStepConnection }>(
    LIST_TASK_INSTANCE_STEPS,
    {
      userId,
      instanceId,
      limit: args.limit,
      nextToken: args.nextToken ?? null,
    },
  );
  return data.listTaskInstanceSteps;
}

/** Drain every step-snapshot page and preserve the backend's numeric step order. */
export async function listAllTaskInstanceSteps(
  userId: string,
  instanceId: string,
): Promise<TaskInstanceStep[]> {
  const steps: TaskInstanceStep[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | null = null;

  do {
    const page = await listTaskInstanceSteps(userId, instanceId, { limit: 100, nextToken });
    steps.push(...page.items);
    nextToken = checkedNextToken('listTaskInstanceSteps', page.nextToken, seenTokens);
  } while (nextToken);

  return steps.sort((left, right) => left.order - right.order);
}

/**
 * Drain EVERY page of one user's assignments. User-centered schedule management must include
 * active and ended rules beyond the first DynamoDB/AppSync page.
 */
export async function listAllTaskAssignmentsForUser(userId: string): Promise<TaskAssignment[]> {
  const assignments: TaskAssignment[] = [];
  let nextToken: string | null = null;
  do {
    const page: TaskAssignmentConnection = await listTaskAssignmentsForUser(userId, {
      limit: 100,
      nextToken,
    });
    assignments.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return assignments;
}

/** Reject a malformed/cyclic pagination response instead of issuing an unbounded request loop. */
function checkedNextToken(
  operation: string,
  nextToken: string | null,
  seenTokens: Set<string>,
): string | null {
  if (!nextToken) return null;
  if (seenTokens.has(nextToken)) {
    throw new Error(`${operation} returned a repeated pagination token.`);
  }
  seenTokens.add(nextToken);
  return nextToken;
}

export async function getTask(taskId: string): Promise<Task | null> {
  const data = await gqlRequest<{ getTask: Task | null }>(GET_TASK, { taskId });
  return data.getTask;
}

export async function listTaskSteps(
  taskId: string,
  args: PageArgs = {},
): Promise<TaskStepConnection> {
  const data = await gqlRequest<{ listTaskSteps: TaskStepConnection }>(LIST_TASK_STEPS, {
    taskId,
    limit: args.limit,
    nextToken: args.nextToken ?? null,
  });
  return data.listTaskSteps;
}

/**
 * Drain EVERY page of a task's steps (following nextToken until exhausted, ≤ 99 steps).
 * Step editing needs the complete set: `reorderTaskSteps` must send every current stepId,
 * so a partially-loaded list can never be allowed to drive a reorder.
 */
export async function listAllTaskSteps(taskId: string): Promise<TaskStep[]> {
  const steps: TaskStep[] = [];
  let nextToken: string | null = null;
  do {
    const page: TaskStepConnection = await listTaskSteps(taskId, { limit: 100, nextToken });
    steps.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return steps.sort((a, b) => a.order - b.order);
}

// ── Mutations ────────────────────────────────────────────────────────────────────
/** Update the caller's own profile (displayName / organizationId / accessibilitySettings). */
export async function updateMyUserProfile(input: UpdateMyUserProfileInput): Promise<UserProfile> {
  const data = await gqlRequest<{ updateMyUserProfile: UserProfile }>(UPDATE_MY_USER_PROFILE, {
    input,
  });
  return data.updateMyUserProfile;
}

export async function selectPrimaryUser(input: SelectPrimaryUserInput): Promise<SupportLink> {
  const data = await gqlRequest<{ selectPrimaryUser: SupportLink }>(SELECT_PRIMARY_USER, { input });
  return data.selectPrimaryUser;
}

export async function unselectPrimaryUser(input: UnselectPrimaryUserInput): Promise<SupportLink> {
  const data = await gqlRequest<{ unselectPrimaryUser: SupportLink }>(UNSELECT_PRIMARY_USER, {
    input,
  });
  return data.unselectPrimaryUser;
}

// ── Task-template mutations ──────────────────────────────────────────────────────
/** Generate a task preview only; the backend does not persist the returned title or steps. */
export async function createAiTask(input: CreateAiTaskInput): Promise<GeneratedAiTask> {
  const data = await gqlRequest<{ createAiTask: GeneratedAiTask }>(CREATE_AI_TASK, { input });
  return data.createAiTask;
}

/** Create a task template owned by the CALLER (the input carries no userId by design). */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const data = await gqlRequest<{ createTask: Task }>(CREATE_TASK, { input });
  return data.createTask;
}

export async function updateTask(input: UpdateTaskInput): Promise<Task> {
  const data = await gqlRequest<{ updateTask: Task }>(UPDATE_TASK, { input });
  return data.updateTask;
}

/** Rejected by the backend while any ACTIVE assignment still references the task. */
export async function deleteTask(taskId: string): Promise<Pick<Task, 'taskId' | 'title'>> {
  const data = await gqlRequest<{ deleteTask: Pick<Task, 'taskId' | 'title'> }>(DELETE_TASK, {
    taskId,
  });
  return data.deleteTask;
}

export async function createTaskStep(input: CreateTaskStepInput): Promise<TaskStep> {
  const data = await gqlRequest<{ createTaskStep: TaskStep }>(CREATE_TASK_STEP, { input });
  return data.createTaskStep;
}

export async function updateTaskStep(input: UpdateTaskStepInput): Promise<TaskStep> {
  const data = await gqlRequest<{ updateTaskStep: TaskStep }>(UPDATE_TASK_STEP, { input });
  return data.updateTaskStep;
}

export async function deleteTaskStep(input: DeleteTaskStepInput): Promise<TaskStep> {
  const data = await gqlRequest<{ deleteTaskStep: TaskStep }>(DELETE_TASK_STEP, { input });
  return data.deleteTaskStep;
}

export async function reorderTaskSteps(input: ReorderTaskStepsInput): Promise<TaskStep[]> {
  const data = await gqlRequest<{ reorderTaskSteps: TaskStep[] }>(REORDER_TASK_STEPS, { input });
  return data.reorderTaskSteps;
}

// ── Task-assignment mutations ────────────────────────────────────────────────────
export async function createTaskAssignment(
  input: CreateTaskAssignmentInput,
): Promise<TaskAssignment> {
  const data = await gqlRequest<{ createTaskAssignment: TaskAssignment }>(CREATE_TASK_ASSIGNMENT, {
    input,
  });
  return data.createTaskAssignment;
}

export async function endTaskAssignment(input: EndTaskAssignmentInput): Promise<TaskAssignment> {
  const data = await gqlRequest<{ endTaskAssignment: TaskAssignment }>(END_TASK_ASSIGNMENT, {
    input,
  });
  return data.endTaskAssignment;
}

export async function deleteTaskAssignment(
  input: DeleteTaskAssignmentInput,
): Promise<TaskAssignment> {
  const data = await gqlRequest<{ deleteTaskAssignment: TaskAssignment }>(DELETE_TASK_ASSIGNMENT, {
    input,
  });
  return data.deleteTaskAssignment;
}
