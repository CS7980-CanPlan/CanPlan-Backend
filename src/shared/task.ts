import { randomUUID } from 'crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  assertUsableCategory,
  categoryCountDelta,
  getDefaultCategoryId,
} from './category';
import { dynamo, TABLE_NAME } from './dynamodb';
import { ENTITY, META_SK, mediaSk, PROFILE_SK, stepSk, taskCategoryKey, taskPk, userPk } from './keys';
import { deleteS3ObjectBestEffort, prepareCoverImageAsset } from './media';
import { ValidationError } from './response';
import type { CreateTaskInput, MediaAsset, Task, TaskStep, UserProfile } from './types';

/** DynamoDB permits at most 100 writes in a transaction. */
const MAX_TRANSACTION_ITEMS = 100;

/**
 * Per-owner task cap. `updateTaskOrder` reorders the whole set in one TransactWrite (capped
 * at 100 items by DynamoDB), so 50 keeps a full reorder well inside that ceiling and keeps a
 * "reorder all my tasks" interaction manageable.
 */
export const MAX_TASKS_PER_OWNER = 50;

/**
 * Persist a task template for `ownerId`: one Task `#META` item, one TaskStep item per
 * nested step, a category-count increment (conditioned on the category existing and not
 * deleting), and an optional cover-image MediaAsset — all in a single transaction. Shared
 * by createTask and createAiTask. The caller supplies `ownerId` (derived from the Cognito
 * identity); it is never taken from the input.
 */
export async function persistTask(ownerId: string, input: CreateTaskInput): Promise<Task> {
  if (!input?.title?.trim()) {
    throw new ValidationError('title is required and cannot be empty');
  }

  const categoryId = await resolveCategoryId(ownerId, input.categoryId);

  const taskId = randomUUID();
  const now = new Date().toISOString();

  // Reserve this task's per-owner global `order` from the owner profile's monotonic counter
  // and build the profile-counter transaction item that advances it (enforcing the 50-task
  // cap), to ride in the same transaction as the Task write.
  const { order, profileUpdate } = await reserveTaskOrder(ownerId, now);

  // Each nested step becomes its own TaskStep item with a 1-based `order` and a stable
  // STEP#<stepId> sort key.
  const steps: TaskStep[] = (input.steps ?? []).map((step, index) => {
    if (!step?.text?.trim()) {
      throw new ValidationError(`step ${index + 1}: text is required and cannot be empty`);
    }
    const description = step.description?.trim();
    return {
      stepId: randomUUID(),
      taskId,
      order: index + 1,
      text: step.text.trim(),
      // Empty/whitespace descriptions are dropped (undefined), not stored as "".
      description: description || undefined,
      // Steps are created without media; type-specific assets attach later via updateTaskStep(media).
      mediaVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
  });

  const task: Task = {
    taskId,
    ownerId,
    title: input.title.trim(),
    categoryId,
    taskCategoryKey: taskCategoryKey(ownerId, categoryId),
    order,
    // Step bookkeeping for concurrency-safe appends: nested steps occupy orders 1..N, so the
    // next append goes at N+1; stepVersion starts at 1 and is bumped on every step-set change.
    stepCount: steps.length,
    stepVersion: 1,
    nextStepOrder: steps.length + 1,
    description: input.description?.trim(),
    createdAt: now,
    updatedAt: now,
  };

  // A create writes one Task row, one row per step, the category count Update, the owner
  // profile counter Update, and one more row when a cover image is supplied. Fail clearly
  // before touching S3 or DynamoDB rather than letting DynamoDB surface its generic
  // transaction-size error.
  const hasCover = input.coverImageS3Key != null;
  const transactionItemCount = 1 + steps.length + 1 + 1 + (hasCover ? 1 : 0);
  if (transactionItemCount > MAX_TRANSACTION_ITEMS) {
    const maxSteps = MAX_TRANSACTION_ITEMS - 1 - 1 - 1 - (hasCover ? 1 : 0);
    throw new ValidationError(
      `a task${hasCover ? ' with a cover image' : ''} may have at most ` +
        `${maxSteps} steps (DynamoDB's ${MAX_TRANSACTION_ITEMS}-item transaction limit)`,
    );
  }

  // Optional cover image: verify + promote the pending upload BEFORE the DB write, so
  // an invalid image fails before any Task row is created. The MediaAsset row rides in
  // the SAME transaction as the Task + steps (so a task never lands referencing a cover
  // row that wasn't written).
  let coverAsset: MediaAsset | undefined;
  if (hasCover) {
    coverAsset = await prepareCoverImageAsset({
      taskId,
      ownerId,
      coverImageS3Key: input.coverImageS3Key!,
    });
    task.coverImageAssetId = coverAsset.assetId;
  }

  const transactItems: Array<Record<string, unknown>> = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: { PK: taskPk(taskId), SK: META_SK, entityType: ENTITY.TASK, ...task },
      },
    },
    ...steps.map((step) => ({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: taskPk(taskId),
          SK: stepSk(step.stepId),
          entityType: ENTITY.TASK_STEP,
          ...step,
        },
      },
    })),
    // Increment the category's task count + guard against a concurrent delete (race-safe
    // attach): the category must still exist and not be flagged for deletion.
    categoryCountDelta(ownerId, categoryId, 1, { blockIfDeleting: true }),
    // Advance the owner's task counters (taskCount + nextTaskOrder) atomically with the write,
    // enforcing the 50-task cap and guaranteeing the reserved `order` is unique under races.
    profileUpdate,
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
      await deleteS3ObjectBestEffort(coverAsset.s3Key, {
        event: 'createTask.coverRollback',
        taskId,
      });
    }
    throw err;
  }

  // Return the created task with the steps it just wrote (clients can also fetch
  // them later via the listTaskSteps query).
  // TaskStep.mediaAssets is a non-null GraphQL field; newly-created nested steps are empty.
  return {
    ...task,
    steps: steps.map((step) => {
      const out = { ...step, mediaAssets: [] };
      delete out.mediaVersion;
      return out;
    }),
  };
}

/**
 * Resolve the category id a new task should be filed under. Omitted/null ⇒ the owner's
 * default category; a blank string is rejected (never silently defaulted); a supplied id
 * must be a real, owned, non-deleting category.
 */
async function resolveCategoryId(
  ownerId: string,
  supplied: string | null | undefined,
): Promise<string> {
  if (supplied == null) return getDefaultCategoryId(ownerId);
  const categoryId = supplied.trim();
  if (!categoryId)
    throw new ValidationError('categoryId cannot be blank; omit it to use the default category');
  await assertUsableCategory(ownerId, categoryId);
  return categoryId;
}

/**
 * Reserve the owner's next global task `order` and build the profile-counter `Update` that
 * advances it inside the create transaction. Reads the `#PROFILE` row for the current
 * `taskCount` (50 cap) + `nextTaskOrder`. Two shapes, because DynamoDB forbids `if_not_exists`
 * in a ConditionExpression, so we branch on whether the profile already carries the counters:
 *  - counters present → reserve `order = nextTaskOrder`, condition `taskCount < 50 AND
 *    nextTaskOrder == reserved`, then `ADD 1` to both. Concurrency-safe: a racing create
 *    reserves the same value, but only one condition holds, so orders never collide.
 *  - counters absent (legacy/pre-feature profile) → initialize taskCount=1, nextTaskOrder=2;
 *    this task takes order 1. The migration backfills accurate counts for older data.
 */
async function reserveTaskOrder(
  ownerId: string,
  now: string,
): Promise<{ order: number; profileUpdate: Record<string, unknown> }> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(ownerId), SK: PROFILE_SK } }),
  );
  const profile = result.Item as UserProfile | undefined;
  if (!profile) {
    throw new ValidationError(
      `owner ${ownerId} has no user profile; create the profile before creating tasks`,
    );
  }

  const hasCounters =
    typeof profile.taskCount === 'number' && typeof profile.nextTaskOrder === 'number';
  if (hasCounters) {
    if (profile.taskCount! >= MAX_TASKS_PER_OWNER) {
      throw new ValidationError(`an owner may have at most ${MAX_TASKS_PER_OWNER} tasks`);
    }
    const reserved = profile.nextTaskOrder!;
    return {
      order: reserved,
      profileUpdate: {
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(ownerId), SK: PROFILE_SK },
          UpdateExpression: 'SET updatedAt = :now ADD taskCount :one, nextTaskOrder :one',
          ConditionExpression:
            'attribute_exists(PK) AND taskCount < :max AND nextTaskOrder = :reserved',
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': MAX_TASKS_PER_OWNER,
            ':reserved': reserved,
            ':now': now,
          },
        },
      },
    };
  }

  return {
    order: 1,
    profileUpdate: {
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: userPk(ownerId), SK: PROFILE_SK },
        UpdateExpression: 'SET taskCount = :one, nextTaskOrder = :two, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(taskCount)',
        ExpressionAttributeValues: { ':one': 1, ':two': 2, ':now': now },
      },
    },
  };
}
