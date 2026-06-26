// Shared Task cascade-delete logic.
//
// A Task owns child rows (its #META anchor, every TaskStep, and every MediaAsset — cover
// image, step media, and task-level media) plus each MediaAsset's S3 binary. Removing all
// of that consistently is non-trivial, so the cascade lives here as the single source of
// truth used by BOTH the owner-scoped `deleteTask` (after an ownership check) and the
// SystemAdmin `adminDeleteTask` / full-user-deletion paths (no ownership check).
//
// Deletion strategy & consistency (unchanged from the original owner deleteTask): a
// DynamoDB transaction is capped at 100 items, so a task with >99 children cannot be
// deleted atomically. Before a MediaAsset can be removed, a durable cleanup journal retains
// its S3 key. Child rows are then bulk-deleted via BatchWriteItem (chunks of 25). Children
// go first; journal rows drive idempotent S3 deletion; the journal and #META are removed
// only after every binary delete succeeds. Thus an interruption keeps the Task + journal
// retryable even if some MediaAsset metadata was already removed. Children are read with
// full Query pagination (any count). Historical Assignments/AssignmentSteps snapshotted
// from this task (under USER#<userId> partitions) are intentionally NEVER deleted here.

import { DeleteCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { batchDelete, batchPut, type ItemKey, queryAllItems, queryAllKeys } from './batch';
import { categoryCountDelta } from './category';
import { dynamo, TABLE_NAME } from './dynamodb';
import {
  ENTITY,
  MEDIA_PREFIX,
  mediaSk,
  META_SK,
  STEP_PREFIX,
  TASK_MEDIA_CLEANUP_PREFIX,
  taskMediaCleanupSk,
  taskPk,
} from './keys';
import { deleteS3ObjectBestEffort } from './media';
import type { MediaAsset, Task } from './types';

/** Read a task's #META row (undefined if absent). */
export async function readTaskMeta(taskId: string): Promise<Task | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  return result.Item as Task | undefined;
}

export interface DeleteTaskCascadeOptions {
  /**
   * A preloaded #META row. Supply it to skip the existence read (e.g. the owner path has
   * already loaded + ownership-checked the task, or a bulk delete already holds the row).
   * When omitted, the cascade reads #META itself and returns null if the task is gone.
   */
  task?: Task;
}

/**
 * Delete a Task and ALL of its owned children + S3 binaries. Returns the deleted task
 * (internal storage attributes stripped), or null when the task does not exist (idempotent).
 * Throws a retryable error if any S3 binary delete fails — leaving the Task + journal intact
 * so a retry can finish. Performs NO authorization: callers must enforce ownership themselves.
 */
export async function deleteTaskCascade(
  taskId: string,
  options: DeleteTaskCascadeOptions = {},
): Promise<Task | null> {
  const id = taskId?.trim();
  if (!id) return null;

  const stored = options.task ?? (await readTaskMeta(id));
  if (!stored) return null; // already gone — idempotent

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
      event: 'deleteTaskCascade',
      taskId: id,
      assetId: cleanup.assetId,
    });
    if (!deleted) failedS3Deletes.push(cleanup.assetId);
  }
  if (failedS3Deletes.length) {
    throw new Error(
      `deleteTaskCascade: ${failedS3Deletes.length} media object(s) could not be deleted; retry the operation`,
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
          `deleteTaskCascade: task ${id} was modified concurrently (its category changed); retry the operation`,
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
