import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { batchDelete, batchPut, type ItemKey, queryAllItems, queryAllKeys } from '../../shared/batch';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ENTITY,
  MEDIA_PREFIX,
  mediaSk,
  META_SK,
  NO_CATEGORY,
  STEP_PREFIX,
  stepSk,
  TASK_CATEGORY_INDEX,
  taskCategoryKey,
  TASK_MEDIA_CLEANUP_PREFIX,
  TASK_OWNER_INDEX,
  taskMediaCleanupSk,
  taskPk,
} from '../../shared/keys';
import { deleteS3ObjectBestEffort, prepareCoverImageAsset } from '../../shared/media';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { normalizeSchedule } from '../../shared/schedule';
import type {
  AppSyncEvent,
  Connection,
  CreateTaskStepInput,
  MediaAsset,
  Task,
  TaskStep,
  UpdateTaskInput,
  UpdateTaskStepInput,
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
    case 'updateTaskStep':
      return updateTaskStep(args.input as UpdateTaskStepInput);
    case 'deleteTask':
      return deleteTask(args.taskId as string);
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

  // No cover-image change: keep the original single-Put behavior.
  if (input.coverImageS3Key == null) {
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

  // ── Cover-image replacement ──────────────────────────────────────────────────
  // Verify + promote the pending upload (S3 copy) BEFORE any DB write.
  const oldCoverAssetId = stored.coverImageAssetId;
  const newCover = await prepareCoverImageAsset({
    taskId,
    ownerId: stored.ownerId,
    coverImageS3Key: input.coverImageS3Key,
  });
  updated.coverImageAssetId = newCover.assetId;

  // Persist the updated Task (new coverImageAssetId) and the new MediaAsset row
  // atomically — the new cover is "active" only once BOTH land.
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: { TableName: TABLE_NAME, Item: updated, ConditionExpression: 'attribute_exists(PK)' },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: taskPk(taskId),
                SK: mediaSk(newCover.assetId),
                entityType: ENTITY.MEDIA_ASSET,
                ...newCover,
              },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // DB failed after the S3 copy — best-effort remove the new object, preserve the error.
    await deleteS3ObjectBestEffort(newCover.s3Key, { event: 'updateTask.coverRollback', taskId });
    throw err;
  }

  // New cover is now active. ONLY NOW remove the previous cover (row + binary). This is
  // best-effort and never rolls back the new cover; a failure is logged (with taskId,
  // old assetId, s3Key) for a retry/cleanup job. Skip when there was no prior cover.
  if (oldCoverAssetId && oldCoverAssetId !== newCover.assetId) {
    await deleteOldCoverImage(taskId, oldCoverAssetId);
  }

  return updated;
}

/**
 * Best-effort cleanup of a replaced cover image: delete its MediaAsset row then its S3
 * object. Never throws — the new cover is already active and must not be rolled back; a
 * failure is logged with enough context (taskId, old assetId, s3Key) to retry.
 */
async function deleteOldCoverImage(taskId: string, oldAssetId: string): Promise<void> {
  try {
    const old = await dynamo.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(oldAssetId) } }),
    );
    const oldKey = (old.Item as MediaAsset | undefined)?.s3Key;
    await dynamo.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(oldAssetId) } }),
    );
    if (oldKey) {
      await deleteS3ObjectBestEffort(oldKey, {
        event: 'updateTask.oldCoverCleanup',
        taskId,
        oldAssetId,
      });
    }
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'updateTask.oldCoverCleanupFailed', taskId, oldAssetId, error: String(err) }),
    );
  }
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

/**
 * updateTaskStep — partial edit of one TaskStep (text and/or mediaRefs).
 *
 * The TaskStep SK is derived from `order` (STEP#<zero-padded-order>), NOT from stepId,
 * so the row can't be addressed directly by stepId. We scan the task's STEP# rows
 * (paginated) to find the one whose stepId matches, then update it by its real key.
 * Only the supplied editable fields change; stepId/taskId/order/createdAt/PK/SK are
 * left intact and updatedAt is bumped.
 */
async function updateTaskStep(input: UpdateTaskStepInput): Promise<TaskStep> {
  const taskId = input?.taskId?.trim();
  const stepId = input?.stepId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');

  // A field is "supplied" when present and non-null (mirrors updateTask). An empty
  // mediaRefs list IS supplied — it replaces the value with none.
  const textProvided = input.text != null;
  const mediaRefsProvided = input.mediaRefs != null;
  if (!textProvided && !mediaRefsProvided) {
    throw new ValidationError('at least one of text or mediaRefs must be supplied');
  }
  let trimmedText: string | undefined;
  if (textProvided) {
    trimmedText = input.text!.trim();
    if (!trimmedText) throw new ValidationError('text cannot be empty');
  }

  const step = await findTaskStep(taskId, stepId);
  if (!step) throw new NotFoundError(`step ${stepId} not found for task ${taskId}`);

  const now = new Date().toISOString();
  const setParts = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': now };
  if (textProvided) {
    setParts.push('#text = :text');
    names['#text'] = 'text';
    values[':text'] = trimmedText;
  }
  if (mediaRefsProvided) {
    setParts.push('#mediaRefs = :mediaRefs');
    names['#mediaRefs'] = 'mediaRefs';
    values[':mediaRefs'] = input.mediaRefs; // may be an empty list
  }

  const result = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      // The step's SK is keyed on its (unchanged) order, not its stepId.
      Key: { PK: taskPk(taskId), SK: stepSk(step.order) },
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      // Defensive — the row was just read, but never resurrect a vanished step.
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  const out = { ...(result.Attributes as Record<string, unknown>) };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  return out as unknown as TaskStep;
}

/**
 * deleteTask — delete a Task and ALL of its owned children: the `#META` item, every
 * TaskStep row, and every MediaAsset row (cover image, step media, and any task-level
 * media without a stepId) plus each MediaAsset's S3 binary.
 *
 * Deletion strategy & consistency: a DynamoDB transaction is capped at 100 items, so a
 * task with >99 children cannot be deleted atomically. Before a MediaAsset can be
 * removed, a durable cleanup journal retains its S3 key. We then bulk-delete child rows
 * via BatchWriteItem (chunks of 25, see src/shared/batch.ts). Children go first; journal
 * rows drive idempotent S3 deletion; the journal and #META are removed only after every
 * binary delete succeeds. Thus an interruption keeps the Task + journal retryable even
 * if some MediaAsset metadata was already removed. Children are read with full Query
 * pagination (any count).
 *
 * Preserved: Assignments/AssignmentSteps snapshotted from this task (under USER#<userId>
 * partitions) are historical records and are intentionally never deleted here.
 */
async function deleteTask(taskId: string): Promise<Task> {
  const id = taskId?.trim();
  if (!id) throw new ValidationError('taskId is required and cannot be empty');

  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(id), SK: META_SK } }),
  );
  const stored = existing.Item as Task | undefined;
  if (!stored) throw new NotFoundError(`task ${id} not found`);

  // Collect every child row (paginated). Media items carry s3Key for binary cleanup.
  const stepKeys = await queryAllKeys(taskPk(id), STEP_PREFIX);
  const mediaItems = await queryAllItems<MediaAsset & ItemKey>(taskPk(id), MEDIA_PREFIX);

  // Persist every S3 key BEFORE deleting a MediaAsset row. If a later BatchWrite
  // partially succeeds, a retry can still read these journal records and clean up all
  // corresponding binaries — including metadata rows already removed in the first run.
  await journalTaskMediaCleanup(id, mediaItems);

  // 1) child rows first (steps + media), chunked under the transaction/batch limits …
  const childKeys: ItemKey[] = [
    ...stepKeys,
    ...mediaItems.map((m) => ({ PK: taskPk(id), SK: mediaSk(m.assetId) })),
  ];
  await batchDelete(childKeys);
  // 2) S3 binaries last, driven by durable journal rows rather than the now-deleted
  // MediaAsset rows. Do not delete #META until every S3 delete has succeeded; an error
  // leaves the Task + journal retryable instead of losing the only copy of an S3 key.
  const cleanupItems = await queryAllItems<TaskMediaCleanup>(taskPk(id), TASK_MEDIA_CLEANUP_PREFIX);
  const failedS3Deletes: string[] = [];
  for (const cleanup of cleanupItems) {
    const deleted = await deleteS3ObjectBestEffort(cleanup.s3Key, {
      event: 'deleteTask',
      taskId: id,
      assetId: cleanup.assetId,
    });
    if (!deleted) failedS3Deletes.push(cleanup.assetId);
  }
  if (failedS3Deletes.length) {
    throw new Error(
      `deleteTask: ${failedS3Deletes.length} media object(s) could not be deleted; retry the operation`,
    );
  }
  await batchDelete(cleanupItems.map(({ PK, SK }) => ({ PK, SK })));
  // 3) Only after children and every binary are gone, remove the parent anchor.
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: taskPk(id), SK: META_SK },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  // Return the deleted metadata minus internal storage attributes.
  const out: Record<string, unknown> = { ...stored };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  delete out.taskCategoryKey;
  return out as unknown as Task;
}

/** Durable S3-cleanup row written before a Task's MediaAsset metadata can disappear. */
interface TaskMediaCleanup extends ItemKey {
  assetId: string;
  s3Key: string;
}

async function journalTaskMediaCleanup(taskId: string, mediaItems: Array<MediaAsset & ItemKey>): Promise<void> {
  if (!mediaItems.length) return;
  const now = new Date().toISOString();
  await batchPut(
    mediaItems
      .filter((media) => !!media.s3Key)
      .map((media) => ({
        PK: taskPk(taskId),
        SK: taskMediaCleanupSk(media.assetId),
        entityType: ENTITY.TASK_MEDIA_CLEANUP,
        assetId: media.assetId,
        s3Key: media.s3Key,
        createdAt: now,
      })),
  );
}

/** Find one TaskStep by stepId among a task's STEP# rows (follows pagination). */
async function findTaskStep(taskId: string, stepId: string): Promise<TaskStep | null> {
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
    const match = ((result.Items as TaskStep[]) ?? []).find((s) => s.stepId === stepId);
    if (match) return match;
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return null;
}
