import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ENTITY,
  META_SK,
  NO_CATEGORY,
  STEP_PREFIX,
  stepSk,
  TASK_CATEGORY_INDEX,
  taskCategoryKey,
  TASK_OWNER_INDEX,
  taskPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { normalizeSchedule } from '../../shared/schedule';
import type {
  AppSyncEvent,
  Connection,
  CreateTaskStepInput,
  Task,
  TaskStep,
  UpdateTaskInput,
} from '../../shared/types';

/**
 * Tasks domain Lambda — task reads plus standalone step creation, routed by the
 * resolved GraphQL field. (createTask itself is its own Lambda — it writes a task
 * and its steps atomically.)
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Task | TaskStep | Connection<Task> | Connection<TaskStep> | null> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'getTask':
      return getTask(args.taskId as string);
    case 'listTaskSteps':
      return listTaskSteps(args.taskId as string, pageArgs(args));
    case 'listTasksByOwner':
      return listTasksByOwner(args.ownerId as string, pageArgs(args));
    case 'listTasksByCategory':
      return listTasksByCategory(
        args.ownerId as string,
        args.categoryId as string | undefined,
        pageArgs(args),
      );
    case 'updateTask':
      return updateTask(args.input as UpdateTaskInput);
    case 'createTaskStep':
      return createTaskStep(args.input as CreateTaskStepInput);
    default:
      throw new Error(`tasks handler: unsupported field "${event.info?.fieldName}"`);
  }
};

async function getTask(taskId: string): Promise<Task | null> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  return (result.Item as Task) ?? null;
}

async function listTaskSteps(taskId: string, page: PageArgs): Promise<Connection<TaskStep>> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  // SK begins_with STEP# returns the steps in zero-padded order, excluding #META/MEDIA#.
  return queryPage<TaskStep>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': taskPk(taskId), ':prefix': STEP_PREFIX },
    },
    page,
  );
}

async function listTasksByOwner(ownerId: string, page: PageArgs): Promise<Connection<Task>> {
  if (!ownerId?.trim()) throw new ValidationError('ownerId is required');
  // taskOwnerIndex is keyed on ownerId/createdAt. MediaAsset items also carry an
  // ownerId, so filter to Task #META rows by entityType.
  return queryPage<Task>(
    {
      TableName: TABLE_NAME,
      IndexName: TASK_OWNER_INDEX,
      KeyConditionExpression: 'ownerId = :owner',
      FilterExpression: 'entityType = :task',
      ExpressionAttributeValues: { ':owner': ownerId, ':task': ENTITY.TASK },
    },
    page,
  );
}

async function listTasksByCategory(
  ownerId: string,
  categoryId: string | undefined,
  page: PageArgs,
): Promise<Connection<Task>> {
  if (!ownerId?.trim()) throw new ValidationError('ownerId is required');
  // Blank/omitted category mirrors createTask's NO_CATEGORY default so the
  // "uncategorized" bucket is queryable with the same key it was written under.
  const category = categoryId?.trim() || NO_CATEGORY;
  // taskCategoryIndex is sparse — only Task items carry taskCategoryKey — so no
  // entityType filter is needed (unlike listTasksByOwner).
  return queryPage<Task>(
    {
      TableName: TABLE_NAME,
      IndexName: TASK_CATEGORY_INDEX,
      KeyConditionExpression: 'taskCategoryKey = :key',
      ExpressionAttributeValues: { ':key': taskCategoryKey(ownerId.trim(), category) },
    },
    page,
  );
}

/**
 * updateTask — partial edit of a Task `#META` item. Read-modify-write so the coupled
 * derived fields stay consistent: changing categoryId recomputes taskCategoryKey (so
 * the task moves buckets in taskCategoryIndex), and a new schedule re-derives
 * nextOccurrenceAt. Only fields present (non-null) on the input change; ownerId,
 * createdAt, and the task's steps are left untouched.
 */
async function updateTask(input: UpdateTaskInput): Promise<Task> {
  const taskId = input?.taskId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  // title is required on a Task, so a supplied title may not be blanked out.
  if (input.title != null && !input.title.trim()) {
    throw new ValidationError('title cannot be empty');
  }
  // Validate any schedule before the read so invalid input fails fast (no wasted read).
  const scheduleUpdate = input.schedule != null ? normalizeSchedule(input.schedule) : undefined;

  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  const stored = existing.Item as Task | undefined;
  if (!stored) throw new NotFoundError(`task ${taskId} not found`);

  // Spread the stored item (carries PK/SK/entityType + every untouched field), then
  // overlay only the provided changes.
  const updated: Task = { ...stored, updatedAt: new Date().toISOString() };
  if (input.title != null) updated.title = input.title.trim();
  if (input.description != null) updated.description = input.description.trim();
  if (input.scheduleRule != null) updated.scheduleRule = input.scheduleRule.trim();
  if (input.status != null) updated.status = input.status;
  if (input.notificationEnabled != null) updated.notificationEnabled = input.notificationEnabled;
  if (input.categoryId != null) {
    // Blank collapses to NO_CATEGORY (as in createTask); recompute the GSI key.
    const categoryId = input.categoryId.trim() || NO_CATEGORY;
    updated.categoryId = categoryId;
    updated.taskCategoryKey = taskCategoryKey(stored.ownerId, categoryId);
  }
  if (scheduleUpdate) {
    updated.schedule = scheduleUpdate.schedule;
    updated.nextOccurrenceAt = scheduleUpdate.nextOccurrenceAt;
  }

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: updated,
      // Fail loudly if the row vanished between the read and the write.
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  return updated;
}

async function createTaskStep(input: CreateTaskStepInput): Promise<TaskStep> {
  const taskId = input?.taskId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!input?.text?.trim()) throw new ValidationError('text is required and cannot be empty');
  if (!Number.isInteger(input.order) || input.order < 1) {
    throw new ValidationError('order is required and must be a positive integer');
  }

  const now = new Date().toISOString();
  const step: TaskStep = {
    stepId: randomUUID(),
    taskId,
    order: input.order,
    text: input.text.trim(),
    mediaRefs: input.mediaRefs,
    expectedDuration: input.expectedDuration,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: taskPk(taskId), SK: stepSk(step.order), entityType: ENTITY.TASK_STEP, ...step },
    }),
  );

  return step;
}
