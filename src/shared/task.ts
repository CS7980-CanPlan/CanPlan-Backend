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
import { normalizeSchedule } from './schedule';
import type { CreateTaskInput, MediaAsset, Task, TaskStep, UserProfile } from './types';

/** DynamoDB permits at most 100 writes in a transaction. */
const MAX_TRANSACTION_ITEMS = 100;

/**
 * An owner may hold at most 50 tasks. The ceiling keeps a whole-owner reorder
 * (`updateTaskOrder`) inside one DynamoDB transaction (100-item limit) with room to spare.
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

  // Read the owner's task counters: the new task takes the next `order`, and the create
  // transaction (below) enforces the 50-task cap. Fail fast on a full owner before doing any
  // S3/DynamoDB write. A profile that predates this feature has no counters yet (the migration
  // backfills them, and createUserProfile initializes them) — we initialize them on the first
  // create instead of hard-failing.
  const profile = await readOwnerProfile(ownerId);
  const hasCounters = typeof profile.nextTaskOrder === 'number';
  const order = hasCounters ? profile.nextTaskOrder! : 1;
  if ((profile.taskCount ?? 0) >= MAX_TASKS_PER_OWNER) {
    throw new ValidationError(`an owner may have at most ${MAX_TASKS_PER_OWNER} tasks`);
  }

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const { schedule, nextOccurrenceAt } = normalizeSchedule(input.schedule);

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
    // Per-owner display position: appended after the owner's current last task.
    order,
    // Step bookkeeping for concurrency-safe appends: nested steps occupy orders 1..N, so the
    // next append goes at N+1; stepVersion starts at 1 and is bumped on every step-set change.
    stepCount: steps.length,
    stepVersion: 1,
    nextStepOrder: steps.length + 1,
    description: input.description?.trim(),
    scheduleRule: input.scheduleRule?.trim(),
    schedule,
    nextOccurrenceAt,
    // Default to enabled alongside a schedule; otherwise leave whatever the client sent
    // (undefined is dropped by the document client's removeUndefinedValues).
    notificationEnabled: schedule ? (input.notificationEnabled ?? true) : input.notificationEnabled,
    createdAt: now,
    updatedAt: now,
  };

  // A create writes one Task row, one row per step, the category count Update, the owner's
  // profile-counter Update, and one more row when a cover image is supplied. Fail clearly
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
    // Advance the owner's task counters atomically with the write: bump nextTaskOrder and
    // increment taskCount. Two shapes (DynamoDB forbids `if_not_exists` in a condition):
    //  - backfilled profile: condition on the 50-cap AND nextTaskOrder still equal to the
    //    value this task's `order` was reserved from, so two concurrent creates can't both
    //    win the same order or exceed the cap (the loser's condition fails and it retries).
    //  - legacy profile with no counters: initialize them (taskCount→1, nextTaskOrder→2),
    //    guarded on the counters still being absent (the concurrency guard for that case).
    hasCounters
      ? {
          Update: {
            TableName: TABLE_NAME,
            Key: { PK: userPk(ownerId), SK: PROFILE_SK },
            UpdateExpression: 'SET nextTaskOrder = :nextOrder, updatedAt = :now ADD taskCount :one',
            ConditionExpression:
              'attribute_exists(PK) AND taskCount < :max AND nextTaskOrder = :order',
            ExpressionAttributeValues: {
              ':nextOrder': order + 1,
              ':order': order,
              ':one': 1,
              ':max': MAX_TASKS_PER_OWNER,
              ':now': now,
            },
          },
        }
      : {
          Update: {
            TableName: TABLE_NAME,
            Key: { PK: userPk(ownerId), SK: PROFILE_SK },
            UpdateExpression: 'SET nextTaskOrder = :nextOrder, taskCount = :one, updatedAt = :now',
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(nextTaskOrder)',
            ExpressionAttributeValues: { ':nextOrder': order + 1, ':one': 1, ':now': now },
          },
        },
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
    // re-throw (mapping a cancellation to a clear message) below.
    if (coverAsset) {
      await deleteS3ObjectBestEffort(coverAsset.s3Key, {
        event: 'createTask.coverRollback',
        taskId,
      });
    }
    // The profile-counter condition fails when the owner hit the 50-task cap or a concurrent
    // create advanced nextTaskOrder; the category condition fails when it was concurrently
    // deleted. All are retryable client errors, not server faults.
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw new ValidationError(
        `cannot create task: the owner's tasks changed concurrently or the ${MAX_TASKS_PER_OWNER}-` +
          'task limit was reached (or the category is being deleted); retry the operation',
      );
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
 * Read the owner's #PROFILE row (for its task counters). The profile must exist — a task
 * cannot be created for an owner with no profile (mirrors getDefaultCategoryId's contract).
 */
async function readOwnerProfile(ownerId: string): Promise<UserProfile> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(ownerId), SK: PROFILE_SK } }),
  );
  const profile = result.Item as UserProfile | undefined;
  if (!profile) {
    throw new ValidationError(
      `owner ${ownerId} has no user profile; create the profile before creating tasks`,
    );
  }
  return profile;
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
