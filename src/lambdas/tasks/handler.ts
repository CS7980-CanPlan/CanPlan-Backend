import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  batchDelete,
  batchPut,
  type ItemKey,
  queryAllItems,
  queryAllKeys,
} from '../../shared/batch';
import { assertCallerOwns } from '../../shared/authz';
import { assertUsableCategory, categoryCountDelta } from '../../shared/category';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ENTITY,
  MEDIA_PREFIX,
  mediaSk,
  META_SK,
  STEP_PREFIX,
  stepSk,
  TASK_CATEGORY_INDEX,
  taskCategoryKey,
  TASK_MEDIA_CLEANUP_PREFIX,
  TASK_OWNER_INDEX,
  taskMediaCleanupSk,
  taskPk,
} from '../../shared/keys';
import {
  deleteS3ObjectBestEffort,
  prepareCoverImageAsset,
  purgeMediaAsset,
  retryTaskMediaCleanup,
} from '../../shared/media';
import {
  decodeNextToken,
  encodeNextToken,
  pageArgs,
  type PageArgs,
  queryPage,
} from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { normalizeSchedule } from '../../shared/schedule';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Connection,
  CreateTaskStepInput,
  DeleteTaskStepInput,
  MediaAsset,
  MediaType,
  ReorderTaskStepsInput,
  StepMediaUpdateInput,
  Task,
  TaskStep,
  UpdateTaskInput,
  UpdateTaskStepInput,
} from '../../shared/types';

/** A task may hold at most 99 steps (also keeps a whole-task reorder inside one transaction). */
const MAX_STEPS_PER_TASK = 99;

/**
 * Tasks domain Lambda — task reads/edits plus standalone step creation, update, delete,
 * and whole-task reordering, routed by the resolved GraphQL field. (createTask itself is
 * its own Lambda — it writes a task and its steps atomically.)
 *
 * TaskSteps use a stable STEP#<stepId> sort key with `order` as a plain attribute, so a
 * step can be reordered in place and a reorder is one atomic transaction. List/read paths
 * therefore sort by the numeric `order`, never by DynamoDB key order.
 *
 * Authorization: Task and TaskStep operations are scoped to the task's owner — the caller's
 * Cognito `sub` must equal `task.ownerId` (there is no delegated-role model yet).
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Task | TaskStep | TaskStep[] | Connection<Task> | Connection<TaskStep> | null> => {
  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    case 'getTask':
      return getTask(identity, args.taskId as string);
    case 'listTaskSteps':
      return listTaskSteps(identity, args.taskId as string, pageArgs(args));
    case 'listTasksByOwner':
      return listTasksByOwner(identity, args.ownerId as string, pageArgs(args));
    case 'listTasksByCategory':
      return listTasksByCategory(
        identity,
        args.ownerId as string,
        args.categoryId as string,
        pageArgs(args),
      );
    case 'updateTask':
      return updateTask(identity, args.input as UpdateTaskInput);
    case 'createTaskStep':
      return createTaskStep(identity, args.input as CreateTaskStepInput);
    case 'updateTaskStep':
      return updateTaskStep(identity, args.input as UpdateTaskStepInput);
    case 'deleteTaskStep':
      return deleteTaskStep(identity, args.input as DeleteTaskStepInput);
    case 'reorderTaskSteps':
      return reorderTaskSteps(identity, args.input as ReorderTaskStepsInput);
    case 'deleteTask':
      return deleteTask(identity, args.taskId as string);
    default:
      throw new Error(`tasks handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/** Read a task's #META row (undefined if absent). */
async function readTaskMeta(taskId: string): Promise<Task | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  return result.Item as Task | undefined;
}

/**
 * Load a task #META, asserting it exists and the caller owns it. Shared by every Task/
 * TaskStep mutation (and reads) located by taskId.
 */
async function loadOwnedTask(identity: AppSyncIdentity | undefined, taskId: string): Promise<Task> {
  const task = await readTaskMeta(taskId);
  if (!task) throw new NotFoundError(`task ${taskId} not found`);
  assertCallerOwns(identity, task.ownerId);
  return task;
}

async function getTask(
  identity: AppSyncIdentity | undefined,
  taskId: string,
): Promise<Task | null> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  const task = await readTaskMeta(taskId.trim());
  if (!task) return null;
  assertCallerOwns(identity, task.ownerId);
  return task;
}

/**
 * listTaskSteps — return a task's steps in ascending numeric `order`, with order preserved
 * ACROSS pages. Because steps are keyed by stepId (not order), the DynamoDB key order is
 * meaningless; and a task is capped at 99 steps, so we read the whole (small) set, sort it
 * by `order` (stepId as a stable tiebreaker), then paginate in application code. `nextToken`
 * is an opaque, base64-encoded offset into that sorted list — NOT a DynamoDB key — and is
 * null on the last page.
 */
async function listTaskSteps(
  identity: AppSyncIdentity | undefined,
  taskId: string,
  page: PageArgs,
): Promise<Connection<TaskStep>> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  const id = taskId.trim();
  await loadOwnedTask(identity, id); // existence + ownership

  const all = await queryAllItems<TaskStep>(taskPk(id), STEP_PREFIX);
  const allMedia = await queryAllItems<MediaAsset>(taskPk(id), MEDIA_PREFIX);
  all.sort((a, b) => a.order - b.order || (a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0));

  const offset = decodeOffset(page.nextToken);
  if (offset < 0 || offset > all.length) throw new ValidationError('invalid nextToken');
  const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : all.length;
  const slice = all.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const nextToken = nextOffset < all.length ? encodeNextToken({ offset: nextOffset }) : null;
  return { items: slice.map((step) => withStepMedia(step, mediaForStep(allMedia, step.stepId))), nextToken };
}

/** Decode the opaque app-level offset cursor (0 when absent). */
function decodeOffset(token?: string): number {
  const decoded = decodeNextToken(token);
  if (!decoded) return 0;
  const offset = (decoded as { offset?: unknown }).offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset)) {
    throw new ValidationError('invalid nextToken');
  }
  return offset;
}

async function listTasksByOwner(
  identity: AppSyncIdentity | undefined,
  ownerId: string,
  page: PageArgs,
): Promise<Connection<Task>> {
  if (!ownerId?.trim()) throw new ValidationError('ownerId is required');
  assertCallerOwns(identity, ownerId.trim());
  // taskOwnerIndex is keyed on ownerId/createdAt. MediaAsset items also carry an
  // ownerId, so filter to Task #META rows by entityType.
  return queryPage<Task>(
    {
      TableName: TABLE_NAME,
      IndexName: TASK_OWNER_INDEX,
      KeyConditionExpression: 'ownerId = :owner',
      FilterExpression: 'entityType = :task',
      ExpressionAttributeValues: { ':owner': ownerId.trim(), ':task': ENTITY.TASK },
    },
    page,
  );
}

async function listTasksByCategory(
  identity: AppSyncIdentity | undefined,
  ownerId: string,
  categoryId: string | undefined,
  page: PageArgs,
): Promise<Connection<Task>> {
  if (!ownerId?.trim()) throw new ValidationError('ownerId is required');
  // Every task belongs to a real category, so a category id is required (there is no
  // implicit "uncategorized" bucket anymore).
  if (!categoryId?.trim()) throw new ValidationError('categoryId is required');
  assertCallerOwns(identity, ownerId.trim());
  // Validate the category exists, belongs to the owner, and isn't mid-deletion — a bad
  // category id is a NOT_FOUND/VALIDATION error, not a silently-empty result.
  await assertUsableCategory(ownerId.trim(), categoryId.trim());
  // taskCategoryIndex is sparse — only Task items carry taskCategoryKey — so no
  // entityType filter is needed (unlike listTasksByOwner).
  return queryPage<Task>(
    {
      TableName: TABLE_NAME,
      IndexName: TASK_CATEGORY_INDEX,
      KeyConditionExpression: 'taskCategoryKey = :key',
      ExpressionAttributeValues: { ':key': taskCategoryKey(ownerId.trim(), categoryId.trim()) },
    },
    page,
  );
}

/**
 * updateTask — partial edit of a Task `#META` item. Read-modify-write so the coupled
 * derived fields stay consistent: changing categoryId recomputes taskCategoryKey (so the
 * task moves buckets in taskCategoryIndex) and is validated against the task's owner; a
 * new schedule re-derives nextOccurrenceAt. Only fields present (non-null) on the input
 * change; ownerId, createdAt, and the task's steps are left untouched.
 */
async function updateTask(
  identity: AppSyncIdentity | undefined,
  input: UpdateTaskInput,
): Promise<Task> {
  const taskId = input?.taskId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  // title is required on a Task, so a supplied title may not be blanked out.
  if (input.title != null && !input.title.trim()) {
    throw new ValidationError('title cannot be empty');
  }
  // A supplied categoryId may not be blank (omit it to leave the category unchanged).
  if (input.categoryId != null && !input.categoryId.trim()) {
    throw new ValidationError('categoryId cannot be blank; omit it to leave it unchanged');
  }
  // Validate any schedule before the read so invalid input fails fast (no wasted read).
  const scheduleUpdate = input.schedule != null ? normalizeSchedule(input.schedule) : undefined;

  const stored = await loadOwnedTask(identity, taskId);

  // Validate a category change against the task's OWNER (read from the stored row, never
  // the client) so a caller cannot move a task into a category they don't own.
  let newCategoryId: string | undefined;
  if (input.categoryId != null) {
    newCategoryId = input.categoryId.trim();
    await assertUsableCategory(stored.ownerId, newCategoryId);
  }
  const categoryChanged = newCategoryId != null && newCategoryId !== stored.categoryId;

  // Spread the stored item (carries PK/SK/entityType + every untouched field), then
  // overlay only the provided changes.
  const updated: Task = { ...stored, updatedAt: new Date().toISOString() };
  if (input.title != null) updated.title = input.title.trim();
  if (input.description != null) updated.description = input.description.trim();
  if (input.scheduleRule != null) updated.scheduleRule = input.scheduleRule.trim();
  if (input.notificationEnabled != null) updated.notificationEnabled = input.notificationEnabled;
  if (newCategoryId != null) {
    updated.categoryId = newCategoryId;
    updated.taskCategoryKey = taskCategoryKey(stored.ownerId, newCategoryId);
  }
  if (scheduleUpdate) {
    updated.schedule = scheduleUpdate.schedule;
    updated.nextOccurrenceAt = scheduleUpdate.nextOccurrenceAt;
  }

  // Optimistic-concurrency guard: the write only lands if the task is STILL in the category
  // we read. This keeps the durable category `taskCount` correct under a concurrent
  // deleteCategory reparent (which would have changed categoryId) — the write fails and the
  // caller retries with fresh data instead of resurrecting a stale category.
  const taskPut = {
    Put: {
      TableName: TABLE_NAME,
      Item: updated,
      ConditionExpression: 'attribute_exists(PK) AND categoryId = :expectedCategory',
      ExpressionAttributeValues: { ':expectedCategory': stored.categoryId },
    },
  };

  // When the category changes, adjust both categories' counts in the SAME transaction:
  // -1 on the old, +1 on the new (the new must exist and not be deleting).
  const countItems = categoryChanged
    ? [
        categoryCountDelta(stored.ownerId, stored.categoryId, -1, { blockIfDeleting: false }),
        categoryCountDelta(stored.ownerId, newCategoryId!, 1, { blockIfDeleting: true }),
      ]
    : [];

  // ── No cover-image change ────────────────────────────────────────────────────
  if (input.coverImageS3Key == null) {
    if (countItems.length === 0) {
      // Plain single-Put fast path (no category move).
      await dynamo.send(new PutCommand(taskPut.Put));
      return updated;
    }
    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: [taskPut, ...countItems] }));
    } catch (err) {
      throw mapCategoryMoveError(err, newCategoryId!);
    }
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

  // Persist the updated Task (new coverImageAssetId) + the new MediaAsset row (+ category
  // count deltas when the category changed) atomically — the new cover is "active" only
  // once they all land.
  const transactItems: Array<Record<string, unknown>> = [
    taskPut,
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
    ...countItems,
  ];
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    // DB failed after the S3 copy — best-effort remove the new object, preserve the error.
    await deleteS3ObjectBestEffort(newCover.s3Key, { event: 'updateTask.coverRollback', taskId });
    throw categoryChanged ? mapCategoryMoveError(err, newCategoryId!) : err;
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
 * Translate a category-move transaction cancellation into a clear error. The +1 on the new
 * category is conditioned on it existing and not being deleted; the task Put is conditioned
 * on the task still being in its prior category. A cancellation therefore means either the
 * target category is gone/deleting, or the task moved underneath us — both are retryable.
 */
function mapCategoryMoveError(err: unknown, newCategoryId: string): Error {
  if ((err as { name?: string }).name === 'TransactionCanceledException') {
    return new ValidationError(
      `cannot move task to category ${newCategoryId}: it is no longer available (deleted or ` +
        'being deleted), or the task was modified concurrently; retry the operation',
    );
  }
  return err as Error;
}

/**
 * Best-effort cleanup of a replaced cover image: delete its MediaAsset row then its S3
 * object. Never throws — the new cover is already active and must not be rolled back; a
 * failure is logged with enough context (taskId, old assetId, s3Key) to retry.
 */
async function deleteOldCoverImage(taskId: string, oldAssetId: string): Promise<void> {
  try {
    const old = await dynamo.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: mediaSk(oldAssetId) },
      }),
    );
    const oldKey = (old.Item as MediaAsset | undefined)?.s3Key;
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: mediaSk(oldAssetId) },
      }),
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
      JSON.stringify({
        event: 'updateTask.oldCoverCleanupFailed',
        taskId,
        oldAssetId,
        error: String(err),
      }),
    );
  }
}

/**
 * createTaskStep — append ONE new step to the end of a task's step list, concurrency-safely.
 *
 * The task must exist and be owned by the caller, and a task may hold at most 99 steps. The
 * step is created at the next append position tracked on the Task (`nextStepOrder`); the
 * supplied `order` must equal it (any other value — e.g. one that duplicates an existing
 * step — is rejected; `reorderTaskSteps` is the supported way to insert/reorder).
 *
 * Atomicity: a single transaction bumps the Task's `stepVersion`, increments `stepCount`
 * (conditioned `< 99`) + `nextStepOrder`, and writes the STEP row — all conditioned on the
 * Task's `stepVersion` still matching the value we read. Optional initial media assets are
 * attached in that same transaction, one per MediaType. Two simultaneous appends therefore
 * cannot both win or produce a duplicate `order`: the loser's `stepVersion` condition fails
 * and it gets a clear, retryable conflict error. Legacy tasks without step metadata are
 * rejected with a migration-required error (run the migration to backfill).
 */
async function createTaskStep(
  identity: AppSyncIdentity | undefined,
  input: CreateTaskStepInput,
): Promise<TaskStep> {
  const taskId = input?.taskId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!input?.text?.trim()) throw new ValidationError('text is required and cannot be empty');
  if (!Number.isInteger(input.order) || input.order < 1) {
    throw new ValidationError('order is required and must be a positive integer');
  }
  const description = normalizeNewDescription(input.description);
  const initialMedia = normalizeStepMediaUpdates(input.media);
  if (initialMedia.some((media) => media.assetId == null)) {
    throw new ValidationError('createTaskStep media entries require a non-null assetId');
  }

  // The task must exist and belong to the caller before we add a step (no orphan steps).
  const task = await loadOwnedTask(identity, taskId);

  // Step metadata is required (createTask sets it; the migration backfills legacy rows).
  if (
    typeof task.stepVersion !== 'number' ||
    typeof task.stepCount !== 'number' ||
    typeof task.nextStepOrder !== 'number'
  ) {
    throw new ValidationError(
      `task ${taskId} is missing step metadata; run the step/category migration before adding steps`,
    );
  }
  if (task.stepCount >= MAX_STEPS_PER_TASK) {
    throw new ValidationError(`a task may have at most ${MAX_STEPS_PER_TASK} steps`);
  }
  const nextOrder = task.nextStepOrder;
  if (input.order !== nextOrder) {
    throw new ValidationError(
      `order must be ${nextOrder} (the next available position); use reorderTaskSteps to insert or reorder`,
    );
  }

  const now = new Date().toISOString();
  // Created without media; type-specific assets attach later via updateTaskStep(media).
  const step: TaskStep = {
    stepId: randomUUID(),
    taskId,
    order: nextOrder,
    text: input.text.trim(),
    description,
    mediaVersion: 0,
    createdAt: now,
    updatedAt: now,
  };

  const attachedMedia: MediaAsset[] = [];
  const mediaWrites: Array<Record<string, unknown>> = [];
  for (const change of initialMedia) {
    const asset = await getMediaAsset(taskId, change.assetId!);
    if (!asset) throw new NotFoundError(`media asset ${change.assetId} not found under task ${taskId}`);
    if (asset.type !== change.type) {
      throw new ValidationError(
        `media asset ${change.assetId} has type ${asset.type}; expected ${change.type}`,
      );
    }
    if (task.coverImageAssetId === asset.assetId) {
      throw new ValidationError('cannot attach the task cover image to a step');
    }
    if (asset.stepId) {
      throw new ValidationError(`media asset ${change.assetId} is already attached to a step`);
    }
    attachedMedia.push({ ...asset, stepId: step.stepId });
    mediaWrites.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: mediaSk(asset.assetId) },
        UpdateExpression: 'SET stepId = :stepId, updatedAt = :now',
        ConditionExpression:
          'attribute_exists(PK) AND attribute_not_exists(stepId) AND #type = :mediaType',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':stepId': step.stepId, ':now': now, ':mediaType': change.type },
      },
    });
  }

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: taskPk(taskId), SK: META_SK },
              UpdateExpression:
                'SET stepCount = stepCount + :one, stepVersion = stepVersion + :one, ' +
                'nextStepOrder = nextStepOrder + :one, updatedAt = :now',
              // Serialize appends (version) + enforce the cap atomically.
              ConditionExpression:
                'attribute_exists(PK) AND stepVersion = :expectedVersion AND stepCount < :max',
              ExpressionAttributeValues: {
                ':one': 1,
                ':now': now,
                ':expectedVersion': task.stepVersion,
                ':max': MAX_STEPS_PER_TASK,
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: taskPk(taskId),
                SK: stepSk(step.stepId),
                entityType: ENTITY.TASK_STEP,
                ...step,
              },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
          ...mediaWrites,
        ],
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw new ValidationError(
        `createTaskStep: the task's steps changed concurrently (another append, or the 99-step ` +
          'limit was reached); reload the steps and retry',
      );
    }
    throw err;
  }

  return withStepMedia(step, mediaForStep(attachedMedia, step.stepId));
}

/** Trim an optional new-step description; drop empty/whitespace to undefined (not stored). */
function normalizeNewDescription(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * updateTaskStep — partial edit of one TaskStep: text, description, and/or one or more
 * type-specific media slots. A step owns at most one IMAGE, one AUDIO, and one VIDEO; the
 * authoritative association is MediaAsset.stepId, not an asset id stored on the Step.
 *
 * Each `media` entry names a type. A non-null asset id attaches an existing unattached asset
 * of exactly that type (replacing the old asset of that type after the new one is committed).
 * A null/omitted asset id removes that type's current asset. Omitted types are unchanged.
 * The TaskStep `mediaVersion` condition serializes simultaneous media edits so two requests
 * cannot attach different assets to the same type slot.
 */
async function updateTaskStep(
  identity: AppSyncIdentity | undefined,
  input: UpdateTaskStepInput,
): Promise<TaskStep> {
  const taskId = input?.taskId?.trim();
  const stepId = input?.stepId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');

  const textProvided = input.text != null;
  const descProvided = input.description !== undefined;
  const mediaUpdates = normalizeStepMediaUpdates(input.media);
  if (!textProvided && !descProvided && !mediaUpdates.length) {
    throw new ValidationError(
      'at least one of text, description, or a non-empty media list must be supplied',
    );
  }
  let trimmedText: string | undefined;
  if (textProvided) {
    trimmedText = input.text!.trim();
    if (!trimmedText) throw new ValidationError('text cannot be empty');
  }
  // description: null clears; a non-null string is trimmed and must be non-empty.
  const descClear = descProvided && input.description === null;
  let trimmedDesc: string | undefined;
  if (descProvided && !descClear) {
    trimmedDesc = input.description!.trim();
    if (!trimmedDesc)
      throw new ValidationError('description cannot be empty; use null to clear it');
  }
  // The task must exist and belong to the caller (after pure-input validation, before IO).
  const task = await loadOwnedTask(identity, taskId);

  // Drain any prior failed remove/replace cleanup before making another media change.
  // This makes a client retry of the same update converge rather than accumulating
  // orphaned binaries.
  const pendingCleanupCompleted = await retryTaskMediaCleanup(taskId, {
    event: 'updateTaskStep.retryPendingCleanup',
    stepId,
  });
  if (!pendingCleanupCompleted) {
    throw new Error(
      'updateTaskStep: pending media cleanup could not be completed; retry the operation',
    );
  }

  // Locate the step directly by its stable key.
  const step = await getTaskStep(taskId, stepId);
  if (!step) throw new NotFoundError(`step ${stepId} not found for task ${taskId}`);
  const taskMedia = await queryAllItems<MediaAsset>(taskPk(taskId), MEDIA_PREFIX);
  const existingMedia = mediaForStep(taskMedia, stepId);
  const existingByType = new Map(existingMedia.map((asset) => [asset.type, asset]));
  const now = new Date().toISOString();
  const stepKey = { PK: taskPk(taskId), SK: stepSk(stepId) };

  // Field (text/description) mutation clauses shared by every branch.
  const field = buildFieldMutation({
    now,
    textProvided,
    trimmedText,
    descProvided,
    descClear,
    trimmedDesc,
  });

  if (!mediaUpdates.length) {
    await dynamo.send(
      new UpdateCommand({ TableName: TABLE_NAME, Key: stepKey, ...field.toUpdate() }),
    );
    return withStepMedia(
      applyFieldsToStep(step, { trimmedText, descProvided, descClear, trimmedDesc, now }),
      existingMedia,
    );
  }

  const attachmentUpdates: Array<Record<string, unknown>> = [];
  const replacementAssets = new Map<string, MediaAsset>();
  const oldAssetsToPurge = new Map<string, MediaAsset>();

  for (const change of mediaUpdates) {
    const old = existingByType.get(change.type);
    if (change.assetId == null) {
      if (old) oldAssetsToPurge.set(old.assetId, old);
      continue;
    }

    const asset = await getMediaAsset(taskId, change.assetId);
    if (!asset) throw new NotFoundError(`media asset ${change.assetId} not found under task ${taskId}`);
    if (asset.type !== change.type) {
      throw new ValidationError(
        `media asset ${change.assetId} has type ${asset.type}; expected ${change.type}`,
      );
    }
    if (task.coverImageAssetId === asset.assetId) {
      throw new ValidationError('cannot attach the task cover image to a step');
    }

    // Retrying a completed attachment is safe. Any other existing step owner is forbidden.
    if (asset.stepId) {
      if (asset.stepId !== stepId || old?.assetId !== asset.assetId) {
        throw new ValidationError(`media asset ${change.assetId} is already attached to a step`);
      }
    } else {
      attachmentUpdates.push({
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: taskPk(taskId), SK: mediaSk(asset.assetId) },
          UpdateExpression: 'SET stepId = :stepId, updatedAt = :now',
          // The asset must still be unattached and retain the type slot the request named.
          ConditionExpression:
            'attribute_exists(PK) AND attribute_not_exists(stepId) AND #type = :mediaType',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: { ':stepId': stepId, ':now': now, ':mediaType': change.type },
        },
      });
    }
    replacementAssets.set(change.type, { ...asset, stepId });
    if (old && old.assetId !== asset.assetId) oldAssetsToPurge.set(old.assetId, old);
  }

  // Media mutations always update the step's timestamp and mediaVersion. The version
  // condition is the uniqueness lock for every type slot on this step.
  const mediaVersion = step.mediaVersion ?? 0;
  const stepUpdate = field.toUpdate({ extraSet: { mediaVersion: mediaVersion + 1 } });
  stepUpdate.ConditionExpression =
    'attribute_exists(PK) AND (attribute_not_exists(mediaVersion) OR mediaVersion = :expectedMediaVersion)';
  stepUpdate.ExpressionAttributeValues[':expectedMediaVersion'] = mediaVersion;
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [...attachmentUpdates, { Update: { TableName: TABLE_NAME, Key: stepKey, ...stepUpdate } }],
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw new ValidationError(
        'updateTaskStep: media changed concurrently; reload the step and retry',
      );
    }
    throw err;
  }

  // The new type slot(s) are committed before the old binary is deleted. Failure to delete
  // an old S3 object is journaled by purgeMediaAsset and never rolls back the new asset.
  for (const old of oldAssetsToPurge.values()) {
    await purgeMediaAsset(old, { event: 'updateTaskStep.replaceOrRemoveMedia', taskId, stepId });
  }

  const resultMedia = existingMedia
    .filter((asset) => !oldAssetsToPurge.has(asset.assetId))
    .concat([...replacementAssets.values()].filter((asset) => !existingByType.has(asset.type) || existingByType.get(asset.type)?.assetId !== asset.assetId));
  const out = applyFieldsToStep(step, { trimmedText, descProvided, descClear, trimmedDesc, now });
  out.mediaVersion = mediaVersion + 1;
  return withStepMedia(out, mediaForStep(resultMedia, stepId));
}

const MEDIA_TYPE_ORDER: Record<MediaType, number> = { IMAGE: 0, AUDIO: 1, VIDEO: 2 };

/** Validate and normalize type-specific media changes; each type is set at most once. */
function normalizeStepMediaUpdates(value: StepMediaUpdateInput[] | undefined): StepMediaUpdateInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('media must be a non-empty list when supplied');
  }
  const seen = new Set<MediaType>();
  return value.map((change) => {
    if (!change || !Object.prototype.hasOwnProperty.call(MEDIA_TYPE_ORDER, change.type)) {
      throw new ValidationError('each media entry requires type IMAGE, AUDIO, or VIDEO');
    }
    if (seen.has(change.type)) {
      throw new ValidationError(`media type ${change.type} appears more than once`);
    }
    seen.add(change.type);
    const assetId = change.assetId == null ? null : change.assetId.trim();
    if (assetId === '') throw new ValidationError(`media assetId for ${change.type} cannot be empty`);
    return { type: change.type, assetId };
  });
}

/** Return a step's media, enforcing the one-asset-per-type invariant on reads too. */
function mediaForStep(allMedia: MediaAsset[], stepId: string): MediaAsset[] {
  const byType = new Map<MediaType, MediaAsset>();
  for (const asset of allMedia) {
    if (
      asset.stepId !== stepId ||
      !Object.prototype.hasOwnProperty.call(MEDIA_TYPE_ORDER, asset.type)
    )
      continue;
    if (byType.has(asset.type)) {
      throw new ValidationError(`step ${stepId} has multiple ${asset.type} media assets; repair the data`);
    }
    byType.set(asset.type, asset);
  }
  return [...byType.values()].sort((a, b) => MEDIA_TYPE_ORDER[a.type] - MEDIA_TYPE_ORDER[b.type]);
}

interface FieldMutationOpts {
  now: string;
  textProvided: boolean;
  trimmedText?: string;
  descProvided: boolean;
  descClear: boolean;
  trimmedDesc?: string;
}

/**
 * Build the SET/REMOVE clauses for a step's own fields (text + description), with helpers
 * to fold in media-specific SET/REMOVE for the attach/remove transactions.
 */
function buildFieldMutation(opts: FieldMutationOpts) {
  const baseSet: Record<string, string> = {}; // exprName -> attrName
  const baseSetValues: Record<string, unknown> = {};
  const baseRemove: string[] = [];
  if (opts.textProvided) {
    baseSet['#text'] = 'text';
    baseSetValues[':text'] = opts.trimmedText;
  }
  if (opts.descProvided) {
    if (opts.descClear) baseRemove.push('description');
    else {
      baseSet['#description'] = 'description';
      baseSetValues[':description'] = opts.trimmedDesc;
    }
  }

  return {
    toUpdate(extra: { extraSet?: Record<string, unknown>; extraRemove?: string[] } = {}) {
      const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
      const values: Record<string, unknown> = { ':now': opts.now, ...baseSetValues };
      const setParts = ['#updatedAt = :now'];
      const removeParts = [...baseRemove];
      for (const [exprName, attrName] of Object.entries(baseSet)) {
        names[exprName] = attrName;
        setParts.push(`${exprName} = :${attrName.replace(/^#*/, '')}`);
      }
      for (const [attr, val] of Object.entries(extra.extraSet ?? {})) {
        setParts.push(`${attr} = :${attr}`);
        values[`:${attr}`] = val;
      }
      for (const attr of extra.extraRemove ?? []) removeParts.push(attr);
      let expr = `SET ${setParts.join(', ')}`;
      if (removeParts.length) expr += ` REMOVE ${removeParts.join(', ')}`;
      return {
        UpdateExpression: expr,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      };
    },
  };
}

/** Apply the supplied text/description changes to an in-memory step (for the return value). */
function applyFieldsToStep(
  step: TaskStep,
  opts: {
    trimmedText?: string;
    descProvided: boolean;
    descClear: boolean;
    trimmedDesc?: string;
    now: string;
  },
): TaskStep {
  const out: TaskStep = { ...step, updatedAt: opts.now };
  if (opts.trimmedText !== undefined) out.text = opts.trimmedText;
  if (opts.descProvided) {
    if (opts.descClear) delete out.description;
    else out.description = opts.trimmedDesc;
  }
  return out;
}

/** Strip internal storage attributes from a TaskStep before returning it. */
function stripStep(step: TaskStep): TaskStep {
  const out: Record<string, unknown> = { ...step };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  delete out.mediaVersion;
  return out as unknown as TaskStep;
}

/** Hydrate a TaskStep's GraphQL media list from its associated MediaAsset rows. */
function withStepMedia(step: TaskStep, mediaAssets: MediaAsset[]): TaskStep {
  return stripStep({ ...step, mediaAssets });
}

/** Read one TaskStep directly by its stable STEP#<stepId> key (undefined if absent). */
async function getTaskStep(taskId: string, stepId: string): Promise<TaskStep | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: stepSk(stepId) } }),
  );
  return result.Item as TaskStep | undefined;
}

/** Read one MediaAsset row under a task (null if absent). */
async function getMediaAsset(taskId: string, assetId: string): Promise<MediaAsset | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(assetId) } }),
  );
  return result.Item as MediaAsset | undefined;
}

/**
 * reorderTaskSteps — atomically renumber ALL of a task's steps. The request must carry the
 * complete current step set: every existing stepId exactly once, with orders forming a
 * contiguous 1..N permutation (N = number of steps, max 99). Every step's `order` is
 * updated in one transaction (all-or-nothing); step ids, media, task contents,
 * AssignmentSteps, and historical assignments are untouched. Returns the steps sorted by
 * ascending order.
 */
async function reorderTaskSteps(
  identity: AppSyncIdentity | undefined,
  input: ReorderTaskStepsInput,
): Promise<TaskStep[]> {
  const taskId = input?.taskId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  const steps = input?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ValidationError('steps is required and must list the complete current step set');
  }
  if (steps.length > MAX_STEPS_PER_TASK) {
    throw new ValidationError(`a task may have at most ${MAX_STEPS_PER_TASK} steps`);
  }

  // The task must exist and belong to the caller.
  const task = await loadOwnedTask(identity, taskId);

  const n = steps.length;
  const orderByStepId = new Map<string, number>();
  const seenOrders = new Set<number>();
  for (const s of steps) {
    const id = s?.stepId?.trim();
    if (!id) throw new ValidationError('each step requires a stepId');
    if (orderByStepId.has(id)) throw new ValidationError(`stepId ${id} appears more than once`);
    if (!Number.isInteger(s.order) || s.order < 1 || s.order > n) {
      throw new ValidationError(`order for step ${id} must be an integer between 1 and ${n}`);
    }
    if (seenOrders.has(s.order))
      throw new ValidationError(`order ${s.order} appears more than once`);
    orderByStepId.set(id, s.order);
    seenOrders.add(s.order);
  }
  // n distinct integers each in [1, n] ⇒ exactly the contiguous set 1..n.

  // The request must match the task's actual steps exactly (no missing/extra steps).
  const current = await queryAllItems<TaskStep>(taskPk(taskId), STEP_PREFIX);
  const currentMedia = await queryAllItems<MediaAsset>(taskPk(taskId), MEDIA_PREFIX);
  if (current.length !== n) {
    throw new ValidationError(
      `reorderTaskSteps must include all of the task's ${current.length} step(s); received ${n}`,
    );
  }
  for (const stepId of orderByStepId.keys()) {
    if (!current.some((s) => s.stepId === stepId)) {
      throw new NotFoundError(`step ${stepId} not found for task ${taskId}`);
    }
  }

  const now = new Date().toISOString();
  // One atomic transaction updates every step's `order` in place (stable STEP#<stepId>
  // keys, so no key rewrite) PLUS the Task's step metadata: bump `stepVersion` (so a
  // concurrent append/delete is detected), reset `nextStepOrder` to N+1 (orders are now the
  // contiguous 1..N), and re-assert `stepCount` (unchanged) — also backfilling metadata for
  // a legacy task. `order` is a DynamoDB reserved word — alias it.
  const expectedVersion = typeof task.stepVersion === 'number' ? task.stepVersion : undefined;
  const newVersion = (expectedVersion ?? 0) + 1;
  const metaUpdate = {
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: taskPk(taskId), SK: META_SK },
      UpdateExpression:
        'SET stepCount = :n, nextStepOrder = :nextOrder, stepVersion = :newVersion, updatedAt = :now',
      ConditionExpression:
        expectedVersion !== undefined
          ? 'attribute_exists(PK) AND stepVersion = :expectedVersion'
          : 'attribute_exists(PK)',
      ExpressionAttributeValues: {
        ':n': n,
        ':nextOrder': n + 1,
        ':newVersion': newVersion,
        ':now': now,
        ...(expectedVersion !== undefined ? { ':expectedVersion': expectedVersion } : {}),
      },
    },
  };
  const stepUpdates = current.map((step) => ({
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: taskPk(taskId), SK: stepSk(step.stepId) },
      UpdateExpression: 'SET #order = :order, #updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#order': 'order', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':order': orderByStepId.get(step.stepId), ':now': now },
    },
  }));
  try {
    // N step updates + 1 metadata update ≤ 100 items (N ≤ 99).
    await dynamo.send(new TransactWriteCommand({ TransactItems: [...stepUpdates, metaUpdate] }));
  } catch (err) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw new ValidationError(
        `reorderTaskSteps: the task's steps changed concurrently (a step was added or removed); ` +
          'reload the steps and retry',
      );
    }
    throw err;
  }

  return current
    .map((step) => ({ ...step, order: orderByStepId.get(step.stepId)!, updatedAt: now }))
    .sort((a, b) => a.order - b.order)
    .map((step) => withStepMedia(step, mediaForStep(currentMedia, step.stepId)));
}

/**
 * deleteTaskStep — delete one TaskStep and every media asset attached to it (if any).
 *
 * The step is located directly by its stable STEP#<stepId> key. Associated MediaAsset rows
 * are discovered by `stepId` and each metadata row + S3 binary is removed through the shared
 * purgeMediaAsset path. If any S3 delete fails, the operation throws a retryable error rather
 * than silently claiming success; a durable cleanup journal retains the orphaned binary key.
 *
 * Never modifies the Task, any other TaskStep, any Assignment, or any AssignmentStep —
 * historical snapshots are untouched.
 */
async function deleteTaskStep(
  identity: AppSyncIdentity | undefined,
  input: DeleteTaskStepInput,
): Promise<TaskStep> {
  const taskId = input?.taskId?.trim();
  const stepId = input?.stepId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');

  // The task must exist and belong to the caller.
  const task = await loadOwnedTask(identity, taskId);

  // Finish an earlier failed binary cleanup before looking up the step. A previous
  // attempt leaves the step in place (but detached) until its durable S3 journal has
  // been drained, so retrying this same mutation is safe.
  const pendingCleanupCompleted = await retryTaskMediaCleanup(taskId, {
    event: 'deleteTaskStep.retryPendingCleanup',
    stepId,
  });
  if (!pendingCleanupCompleted) {
    throw new Error(
      'deleteTaskStep: pending media cleanup could not be completed; retry the operation',
    );
  }

  const step = await getTaskStep(taskId, stepId);
  if (!step) throw new NotFoundError(`step ${stepId} not found for task ${taskId}`);

  // Delete every type-specific asset before removing the step. purgeMediaAsset records each
  // S3 key durably; if S3 fails, leave the step in place so retry can finish cleanup first.
  const stepMedia = mediaForStep(
    await queryAllItems<MediaAsset>(taskPk(taskId), MEDIA_PREFIX),
    stepId,
  );
  for (const asset of stepMedia) {
    const s3Deleted = await purgeMediaAsset(asset, { event: 'deleteTaskStep', taskId, stepId });
    if (!s3Deleted) {
      throw new Error(
        `deleteTaskStep: media object ${asset.assetId} could not be deleted; retry the operation`,
      );
    }
  }

  // Only remove the TaskStep once its media deletion has completed. When the task carries
  // step metadata, delete the row and decrement `stepCount` (+ bump `stepVersion` to
  // invalidate any in-flight reorder) in ONE transaction so the count never drifts. The
  // step's `order` is NOT reclaimed — deleting can leave an order gap, which is fine;
  // `reorderTaskSteps` renumbers steps to a contiguous 1..N when desired. Legacy tasks
  // without metadata fall back to a plain delete.
  const stepKey = { PK: taskPk(taskId), SK: stepSk(stepId) };
  if (typeof task.stepCount === 'number') {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: TABLE_NAME, Key: stepKey, ConditionExpression: 'attribute_exists(PK)' } },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: taskPk(taskId), SK: META_SK },
              UpdateExpression:
                'SET stepCount = stepCount - :one, stepVersion = if_not_exists(stepVersion, :zero) + :one, updatedAt = :now',
              ConditionExpression: 'attribute_exists(PK) AND stepCount > :zero',
              ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': new Date().toISOString() },
            },
          },
        ],
      }),
    );
  } else {
    await dynamo.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: stepKey, ConditionExpression: 'attribute_exists(PK)' }),
    );
  }

  return withStepMedia(step, stepMedia);
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
async function deleteTask(
  identity: AppSyncIdentity | undefined,
  taskId: string,
): Promise<Task> {
  const id = taskId?.trim();
  if (!id) throw new ValidationError('taskId is required and cannot be empty');

  // Existence + ownership.
  const stored = await loadOwnedTask(identity, id);

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
  // 3) Only after children and every binary are gone, remove the parent anchor AND
  // decrement its category's task count — atomically. The #META delete is guarded on the
  // task still being in `stored.categoryId`, so a concurrent reparent (which changed the
  // category + already adjusted counts) makes this fail; a retry re-reads and decrements
  // the correct category. Keeps the durable category `taskCount` accurate.
  if (stored.categoryId) {
    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: TABLE_NAME,
                Key: { PK: taskPk(id), SK: META_SK },
                ConditionExpression: 'attribute_exists(PK) AND categoryId = :cat',
                ExpressionAttributeValues: { ':cat': stored.categoryId },
              },
            },
            categoryCountDelta(stored.ownerId, stored.categoryId, -1, { blockIfDeleting: false }),
          ],
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'TransactionCanceledException') {
        throw new Error(
          `deleteTask: task ${id} was modified concurrently (its category changed); retry the operation`,
        );
      }
      throw err;
    }
  } else {
    // Legacy task without a category (pre-migration) — just remove the anchor.
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(id), SK: META_SK },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  }

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

async function journalTaskMediaCleanup(
  taskId: string,
  mediaItems: Array<MediaAsset & ItemKey>,
): Promise<void> {
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
