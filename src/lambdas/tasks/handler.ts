import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ENTITY,
  META_SK,
  STEP_PREFIX,
  stepSk,
  TASK_OWNER_INDEX,
  taskPk,
} from '../../shared/keys';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, CreateTaskStepInput, Task, TaskStep } from '../../shared/types';

/**
 * Tasks domain Lambda — task reads plus standalone step creation, routed by the
 * resolved GraphQL field. (createTask itself is its own Lambda — it writes a task
 * and its steps atomically.)
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Task | Task[] | TaskStep | TaskStep[] | null> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'getTask':
      return getTask(args.taskId as string);
    case 'listTaskSteps':
      return listTaskSteps(args.taskId as string);
    case 'listTasksByOwner':
      return listTasksByOwner(args.ownerId as string);
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

async function listTaskSteps(taskId: string): Promise<TaskStep[]> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  // SK begins_with STEP# returns the steps in zero-padded order, excluding #META/MEDIA#.
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': taskPk(taskId), ':prefix': STEP_PREFIX },
    }),
  );
  return (result.Items as TaskStep[]) ?? [];
}

async function listTasksByOwner(ownerId: string): Promise<Task[]> {
  if (!ownerId?.trim()) throw new ValidationError('ownerId is required');
  // taskOwnerIndex is keyed on ownerId/createdAt. MediaAsset items also carry an
  // ownerId, so filter to Task #META rows by entityType.
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: TASK_OWNER_INDEX,
      KeyConditionExpression: 'ownerId = :owner',
      FilterExpression: 'entityType = :task',
      ExpressionAttributeValues: { ':owner': ownerId, ':task': ENTITY.TASK },
    }),
  );
  return (result.Items as Task[]) ?? [];
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
