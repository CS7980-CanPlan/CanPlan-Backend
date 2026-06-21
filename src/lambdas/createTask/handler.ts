import { randomUUID } from 'crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, META_SK, mediaSk, NO_CATEGORY, stepSk, taskCategoryKey, taskPk } from '../../shared/keys';
import { deleteS3ObjectBestEffort, prepareCoverImageAsset } from '../../shared/media';
import { ValidationError } from '../../shared/response';
import { normalizeSchedule } from '../../shared/schedule';
import type { AppSyncEvent, CreateTaskInput, MediaAsset, Task, TaskStep } from '../../shared/types';

/** DynamoDB permits at most 100 writes in a transaction. */
const MAX_TRANSACTION_ITEMS = 100;

/**
 * createTask — create a reusable task template owned by a SupportPerson or
 * OrgAdmin. Writes one Task `#META` item plus one TaskStep item per nested step,
 * each as a separate row (never an embedded array). Task and step writes happen
 * in a single transaction so a task never lands without its steps.
 *
 * Assignment creation is a separate operation (createAssignment) — not done here.
 */
export const handler = async (event: AppSyncEvent<{ input: CreateTaskInput }>): Promise<Task> => {
  const { input } = event.arguments;

  if (!input?.ownerId?.trim()) {
    throw new ValidationError('ownerId is required and cannot be empty');
  }
  if (!input?.title?.trim()) {
    throw new ValidationError('title is required and cannot be empty');
  }

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const ownerId = input.ownerId.trim();
  // Blank/omitted category collapses to the reserved NO_CATEGORY bucket so every
  // Task has a queryable taskCategoryKey (no missing-attribute special case).
  const categoryId = input.categoryId?.trim() || NO_CATEGORY;

  const { schedule, nextOccurrenceAt } = normalizeSchedule(input.schedule);

  const task: Task = {
    taskId,
    ownerId,
    title: input.title.trim(),
    categoryId,
    taskCategoryKey: taskCategoryKey(ownerId, categoryId),
    description: input.description?.trim(),
    scheduleRule: input.scheduleRule?.trim(),
    status: input.status ?? 'DRAFT',
    schedule,
    nextOccurrenceAt,
    // Default to enabled alongside a schedule; otherwise leave whatever the client sent
    // (undefined is dropped by the document client's removeUndefinedValues).
    notificationEnabled: schedule ? (input.notificationEnabled ?? true) : input.notificationEnabled,
    createdAt: now,
    updatedAt: now,
  };

  // Each nested step becomes its own TaskStep item with a 1-based, zero-padded order.
  const steps: TaskStep[] = (input.steps ?? []).map((step, index) => {
    if (!step?.text?.trim()) {
      throw new ValidationError(`step ${index + 1}: text is required and cannot be empty`);
    }
    return {
      stepId: randomUUID(),
      taskId,
      order: index + 1,
      text: step.text.trim(),
      // Steps are created without media; it's attached later via updateTaskStep.
      createdAt: now,
      updatedAt: now,
    };
  });

  // A create writes one Task row, one row per step, and one more row when a cover
  // image is supplied. Fail clearly before touching S3 or DynamoDB rather than letting
  // DynamoDB surface its generic transaction-size error.
  const transactionItemCount = 1 + steps.length + (input.coverImageS3Key != null ? 1 : 0);
  if (transactionItemCount > MAX_TRANSACTION_ITEMS) {
    const maxSteps = MAX_TRANSACTION_ITEMS - 1 - (input.coverImageS3Key != null ? 1 : 0);
    throw new ValidationError(
      `a task${input.coverImageS3Key != null ? ' with a cover image' : ''} may have at most ` +
        `${maxSteps} steps (DynamoDB's ${MAX_TRANSACTION_ITEMS}-item transaction limit)`,
    );
  }

  // Optional cover image: verify + promote the pending upload BEFORE the DB write, so
  // an invalid image fails before any Task row is created. The MediaAsset row rides in
  // the SAME transaction as the Task + steps (so a task never lands referencing a cover
  // row that wasn't written).
  let coverAsset: MediaAsset | undefined;
  if (input.coverImageS3Key != null) {
    coverAsset = await prepareCoverImageAsset({
      taskId,
      ownerId,
      coverImageS3Key: input.coverImageS3Key,
    });
    task.coverImageAssetId = coverAsset.assetId;
  }

  const transactItems: Array<{ Put: { TableName: string; Item: Record<string, unknown> } }> = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: { PK: taskPk(taskId), SK: META_SK, entityType: ENTITY.TASK, ...task },
      },
    },
    ...steps.map((step) => ({
      Put: {
        TableName: TABLE_NAME,
        Item: { PK: taskPk(taskId), SK: stepSk(step.order), entityType: ENTITY.TASK_STEP, ...step },
      },
    })),
  ];
  if (coverAsset) {
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: taskPk(taskId),
          SK: mediaSk(coverAsset.assetId),
          entityType: ENTITY.MEDIA_ASSET,
          ...coverAsset,
        },
      },
    });
  }

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    // S3 and DynamoDB can't be atomic: the cover object was already copied to its final
    // key. Best-effort remove it so the failed create leaves nothing behind, then
    // re-throw the ORIGINAL error.
    if (coverAsset) {
      await deleteS3ObjectBestEffort(coverAsset.s3Key, { event: 'createTask.coverRollback', taskId });
    }
    throw err;
  }

  // Return the created task with the steps it just wrote (clients can also fetch
  // them later via the listTaskSteps query).
  return { ...task, steps };
};
