import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { batchDelete, queryAllKeys } from '../../shared/batch';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ASSIGN_PREFIX,
  assignSk,
  assignStepPrefix,
  assignStepSk,
  ENTITY,
  META_SK,
  STEP_PREFIX,
  taskPk,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import type {
  AppSyncEvent,
  Assignment,
  AssignmentStatus,
  AssignmentStep,
  Connection,
  CreateAssignmentInput,
  DeleteAssignmentInput,
  PersistedAssignmentStatus,
  SetAssignmentStepCompletionInput,
  TaskStep,
  UpdateAssignmentStatusInput,
} from '../../shared/types';

/** A DynamoDB transaction may carry at most 100 items (1 Assignment + its steps). */
const MAX_TRANSACTION_ITEMS = 100;
const MAX_ASSIGNMENT_STEPS = MAX_TRANSACTION_ITEMS - 1;

/** Statuses a client may persist via updateAssignmentStatus (OVERDUE is derived). */
const SETTABLE_STATUSES: readonly AssignmentStatus[] = ['TO_DO', 'COMPLETED', 'SKIPPED'];

/**
 * Map a stored status to a valid persisted status, absorbing legacy values written
 * by the old model so the new GraphQL enum never sees an invalid string on reads:
 *   ACTIVE/PAUSED -> TO_DO, CANCELLED -> SKIPPED, COMPLETED -> COMPLETED.
 * Anything unrecognised falls back to TO_DO.
 */
export function normalizePersistedStatus(raw: unknown): PersistedAssignmentStatus {
  switch (raw) {
    case 'TO_DO':
    case 'ACTIVE':
    case 'PAUSED':
      return 'TO_DO';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'SKIPPED':
    case 'CANCELLED':
      return 'SKIPPED';
    default:
      return 'TO_DO';
  }
}

/**
 * Derive the API-facing status. An assignment is OVERDUE when its persisted status
 * is TO_DO, it has a dueDate, and that dueDate is earlier than now. Assignments
 * without a dueDate are never OVERDUE.
 */
export function deriveStatus(
  persisted: PersistedAssignmentStatus,
  dueDate: string | undefined,
  nowMs: number,
): AssignmentStatus {
  if (persisted !== 'TO_DO' || !dueDate) return persisted;
  const due = Date.parse(dueDate);
  return Number.isNaN(due) || due >= nowMs ? persisted : 'OVERDUE';
}

/** Project a stored assignment row into the API shape (legacy-mapped + derived status). */
function presentAssignment(item: Record<string, unknown>, nowMs: number): Assignment {
  const persisted = normalizePersistedStatus(item.status);
  // Drop storage-only / removed attributes (PK/SK/entityType/legacy `active`).
  const out = { ...item };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  delete out.active;
  out.status = deriveStatus(persisted, item.dueDate as string | undefined, nowMs);
  return out as unknown as Assignment;
}

/**
 * Assignments domain Lambda — assign a task template to a user (snapshotting its
 * steps), update an assignment's status, toggle a step's completion, and list a
 * user's assignments or one assignment's steps. Routed by GraphQL field.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Assignment | AssignmentStep | Connection<Assignment> | Connection<AssignmentStep>> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createAssignment':
      return createAssignment(args.input as CreateAssignmentInput);
    case 'updateAssignmentStatus':
      return updateAssignmentStatus(args.input as UpdateAssignmentStatusInput);
    case 'setAssignmentStepCompletion':
      return setAssignmentStepCompletion(args.input as SetAssignmentStepCompletionInput);
    case 'deleteAssignment':
      return deleteAssignment(args.input as DeleteAssignmentInput);
    case 'listAssignmentsForUser':
      return listAssignmentsForUser(args.userId as string, pageArgs(args));
    case 'listAssignmentSteps':
      return listAssignmentSteps(args.userId as string, args.assignmentId as string, pageArgs(args));
    default:
      throw new Error(`assignments handler: unsupported field "${event.info?.fieldName}"`);
  }
};

async function createAssignment(input: CreateAssignmentInput): Promise<Assignment> {
  const taskId = input?.taskId?.trim();
  const userId = input?.userId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!userId) throw new ValidationError('userId is required and cannot be empty');

  // The referenced template must exist before we snapshot it.
  const task = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  if (!task.Item) throw new NotFoundError(`task ${taskId} not found`);

  // Load the template's steps (the source of the per-assignment snapshot).
  const taskSteps = await loadTaskSteps(taskId);
  if (taskSteps.length > MAX_ASSIGNMENT_STEPS) {
    throw new ValidationError(
      `task ${taskId} has ${taskSteps.length} steps; an assignment may snapshot at most ` +
        `${MAX_ASSIGNMENT_STEPS} steps (DynamoDB's 100-item transaction limit)`,
    );
  }

  // assignmentId is globally unique so the SK is ASSIGN#<assignmentId>, never
  // ASSIGN#<taskId> — a user can hold many assignments of the same task template.
  const assignmentId = randomUUID();
  const now = new Date().toISOString();
  // Always created TO_DO; status is server-controlled, never client-supplied.
  const assignment: Assignment = {
    assignmentId,
    taskId,
    userId,
    assignedBy: input.assignedBy?.trim(),
    dueDate: input.dueDate,
    recurrence: input.recurrence,
    scheduleRule: input.scheduleRule,
    status: 'TO_DO',
    assignedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // One AssignmentStep snapshot per TaskStep, all initialized incomplete.
  const steps: AssignmentStep[] = taskSteps.map((step) => ({
    assignmentId,
    taskId,
    stepId: step.stepId,
    order: step.order,
    text: step.text,
    mediaRefs: step.mediaRefs,
    completed: false,
    createdAt: now,
    updatedAt: now,
  }));

  // Assignment + step snapshots land atomically — an Assignment never exists
  // without its step records.
  await dynamo.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: userPk(userId),
              SK: assignSk(assignmentId),
              entityType: ENTITY.ASSIGNMENT,
              ...assignment,
            },
            // Never clobber an existing assignment row (defensive — assignmentId is unique).
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        ...steps.map((step) => ({
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: userPk(userId),
              SK: assignStepSk(assignmentId, step.stepId),
              entityType: ENTITY.ASSIGNMENT_STEP,
              ...step,
            },
          },
        })),
      ],
    }),
  );

  return presentAssignment({ ...assignment }, Date.parse(now));
}

async function updateAssignmentStatus(input: UpdateAssignmentStatusInput): Promise<Assignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  if (!input?.status) throw new ValidationError('status is required');
  if (input.status === 'OVERDUE') {
    throw new ValidationError('OVERDUE is a derived status and cannot be set');
  }
  if (!SETTABLE_STATUSES.includes(input.status)) {
    throw new ValidationError(`status must be one of ${SETTABLE_STATUSES.join(', ')}`);
  }
  const status: PersistedAssignmentStatus = input.status;

  // Cannot complete an assignment while any of its steps is still incomplete.
  // (Zero-step assignments may be completed.)
  if (status === 'COMPLETED') {
    const steps = await loadAllAssignmentSteps(userId, assignmentId);
    if (steps.some((s) => !s.completed)) {
      throw new ValidationError(
        'cannot mark assignment COMPLETED while one or more steps are incomplete',
      );
    }
  }

  const now = new Date().toISOString();
  // `status` is a DynamoDB reserved word, so alias it.
  const result = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: assignSk(assignmentId) },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':status': status, ':updatedAt': now },
      // Fail loudly instead of creating a stub row if the assignment doesn't exist.
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );

  return presentAssignment(result.Attributes as Record<string, unknown>, Date.parse(now));
}

async function setAssignmentStepCompletion(
  input: SetAssignmentStepCompletionInput,
): Promise<AssignmentStep> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  const stepId = input?.stepId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');
  if (typeof input.completed !== 'boolean') throw new ValidationError('completed is required');

  // The assignment must exist (and, via the user-scoped key, belong to this user).
  const assignment = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: assignSk(assignmentId) } }),
  );
  if (!assignment.Item) {
    throw new NotFoundError(`assignment ${assignmentId} not found for user ${userId}`);
  }
  // A terminal assignment's step state is frozen.
  const persisted = normalizePersistedStatus(assignment.Item.status);
  if (persisted === 'COMPLETED' || persisted === 'SKIPPED') {
    throw new ValidationError(
      `cannot change step completion on a ${persisted} assignment`,
    );
  }

  const now = new Date().toISOString();
  const setCompletedAt = input.completed
    ? 'SET completed = :completed, completedAt = :completedAt, updatedAt = :updatedAt'
    : 'SET completed = :completed, updatedAt = :updatedAt REMOVE completedAt';
  const values: Record<string, unknown> = { ':completed': input.completed, ':updatedAt': now };
  if (input.completed) values[':completedAt'] = now;

  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: assignStepSk(assignmentId, stepId) },
        UpdateExpression: setCompletedAt,
        ExpressionAttributeValues: values,
        // The step snapshot must already exist under this assignment.
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    const step = { ...(result.Attributes as Record<string, unknown>) };
    delete step.PK;
    delete step.SK;
    delete step.entityType;
    return step as unknown as AssignmentStep;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`step ${stepId} not found for assignment ${assignmentId}`);
    }
    throw err;
  }
}

/**
 * deleteAssignment — delete an Assignment row and all of its AssignmentStep snapshots.
 *
 * Same delete-children-first strategy as deleteTask (see tasks/handler.ts): a >99-step
 * assignment exceeds DynamoDB's 100-item transaction cap, so we bulk-delete via
 * BatchWriteItem (chunks of 25, non-transactional — see src/shared/batch.ts). The
 * ASSIGN_STEP# child rows go FIRST and the ASSIGN# row LAST so an interrupted run leaves
 * the assignment findable and the whole operation idempotently retryable, never orphaning
 * a step snapshot. Step keys are collected with full Query pagination. The source Task
 * and its TaskSteps live under TASK#<taskId> and are never touched here.
 */
async function deleteAssignment(input: DeleteAssignmentInput): Promise<Assignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');

  // The user-scoped key both verifies existence and confirms the assignment is this user's.
  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: assignSk(assignmentId) } }),
  );
  if (!existing.Item) {
    throw new NotFoundError(`assignment ${assignmentId} not found for user ${userId}`);
  }

  // 1) child ASSIGN_STEP# rows first …
  const stepKeys = await queryAllKeys(userPk(userId), assignStepPrefix(assignmentId));
  await batchDelete(stepKeys);
  // 2) … then the assignment row last, guarded so it never resurrects.
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: assignSk(assignmentId) },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  // Return the deleted assignment in API shape (strips PK/SK/entityType, derives status).
  return presentAssignment(existing.Item, Date.now());
}

async function listAssignmentsForUser(
  userId: string,
  page: PageArgs,
): Promise<Connection<Assignment>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  // begins_with ASSIGN# returns assignment rows only — ASSIGN_STEP# rows do not
  // match this prefix (their 7th char is `_`, not `#`).
  const result = await queryPage<Record<string, unknown>>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': ASSIGN_PREFIX },
    },
    page,
  );
  const nowMs = Date.now();
  return { items: result.items.map((item) => presentAssignment(item, nowMs)), nextToken: result.nextToken };
}

async function listAssignmentSteps(
  userId: string,
  assignmentId: string,
  page: PageArgs,
): Promise<Connection<AssignmentStep>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  if (!assignmentId?.trim()) throw new ValidationError('assignmentId is required');

  const result = await queryPage<AssignmentStep>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': userPk(userId),
        ':prefix': assignStepPrefix(assignmentId),
      },
    },
    page,
  );
  // Step snapshots are keyed by stepId, so sort the page by `order` for the client.
  result.items.sort((a, b) => a.order - b.order);
  return result;
}

/** Read every TaskStep of a template (follows pagination) for the snapshot. */
async function loadTaskSteps(taskId: string): Promise<TaskStep[]> {
  const steps: TaskStep[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': taskPk(taskId), ':prefix': STEP_PREFIX },
        ExclusiveStartKey: startKey,
      }),
    );
    steps.push(...((result.Items as TaskStep[]) ?? []));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return steps;
}

/** Read every AssignmentStep of one assignment (follows pagination). */
async function loadAllAssignmentSteps(
  userId: string,
  assignmentId: string,
): Promise<AssignmentStep[]> {
  const steps: AssignmentStep[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':prefix': assignStepPrefix(assignmentId),
        },
        ExclusiveStartKey: startKey,
      }),
    );
    steps.push(...((result.Items as AssignmentStep[]) ?? []));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return steps;
}
