import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { requireCaller } from '../../shared/authz';
import { categoryCountDelta, getDefaultCategoryId, getOwnedCategory } from '../../shared/category';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  CATEGORY_PREFIX,
  categorySk,
  DEFAULT_CATEGORY_NAME,
  ENTITY,
  isDefaultCategoryName,
  META_SK,
  TASK_CATEGORY_INDEX,
  taskCategoryKey,
  taskPk,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Category,
  Connection,
  CreateCategoryInput,
  DeleteCategoryInput,
  Task,
  UpdateCategoryInput,
} from '../../shared/types';

/**
 * Categories domain Lambda — task categories that are PRIVATE to their owner, routed by
 * the resolved GraphQL field. The owner is always the authenticated caller
 * (event.identity.sub); no operation accepts a client-supplied owner id. Categories
 * share the USER#<ownerId> partition with the owner's other rows under a CATEGORY#
 * sort-key prefix.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Category | Connection<Category> | null> => {
  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    case 'createCategory':
      return createCategory(identity, args.input as CreateCategoryInput);
    case 'listMyCategories':
      return listMyCategories(identity, pageArgs(args));
    case 'updateCategory':
      return updateCategory(identity, args.input as UpdateCategoryInput);
    case 'deleteCategory':
      return deleteCategory(identity, args.input as DeleteCategoryInput);
    default:
      throw new Error(`categories handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/** Strip internal storage attributes (PK/SK/entityType/deleting/taskCount) before returning. */
function stripCategory(item: Category | Record<string, unknown>): Category {
  const out = { ...(item as Record<string, unknown>) };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  delete out.deleting;
  delete out.taskCount;
  return out as unknown as Category;
}

async function createCategory(
  identity: AppSyncIdentity | undefined,
  input: CreateCategoryInput,
): Promise<Category> {
  const ownerId = requireCaller(identity);
  const name = input?.name?.trim();
  if (!name) throw new ValidationError('name is required and cannot be empty');
  // The reserved default name is owned exclusively by the auto-created default category.
  if (isDefaultCategoryName(name)) {
    throw new ValidationError(`"${DEFAULT_CATEGORY_NAME}" is reserved for the default category`);
  }

  const categoryId = randomUUID();
  const now = new Date().toISOString();
  const category: Category = {
    categoryId,
    ownerId,
    name,
    color: input.color?.trim(),
    sortOrder: input.sortOrder,
    isDefault: false,
    taskCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(ownerId),
        SK: categorySk(categoryId),
        entityType: ENTITY.CATEGORY,
        ...category,
      },
    }),
  );

  return category;
}

async function listMyCategories(
  identity: AppSyncIdentity | undefined,
  page: PageArgs,
): Promise<Connection<Category>> {
  const ownerId = requireCaller(identity);
  // SK begins_with CATEGORY# scopes the USER#<ownerId> partition to category rows
  // (excludes #PROFILE, ASSIGN#, ASSIGN_STEP#, …).
  const result = await queryPage<Record<string, unknown>>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(ownerId), ':prefix': CATEGORY_PREFIX },
    },
    page,
  );
  return { items: result.items.map(stripCategory), nextToken: result.nextToken };
}

/**
 * Edit one of the caller's own categories with a targeted UpdateCommand (NOT a full-item
 * Put) so internal state — `isDefault`, `taskCount`, `createdAt`, and especially an
 * in-progress `deleting` flag — is preserved. At least one of name/color/sortOrder must be
 * supplied (a field key being present counts, including explicit null).
 *
 * Null semantics: `color`/`sortOrder` may be cleared with an explicit `null` (REMOVE);
 * `name` is required, so an explicit `null` name is rejected.
 *
 * The default category's `name` is immutable — any `name` key (even null/unchanged) is
 * rejected; color/sortOrder are allowed. A normal category cannot be renamed to the
 * reserved default name. The write is conditioned on the category existing and NOT being
 * deleted, so a concurrent `deleteCategory` lock is never clobbered.
 */
async function updateCategory(
  identity: AppSyncIdentity | undefined,
  input: UpdateCategoryInput,
): Promise<Category> {
  const ownerId = requireCaller(identity);
  const categoryId = input?.categoryId?.trim();
  if (!categoryId) throw new ValidationError('categoryId is required and cannot be empty');

  const nameKeyPresent = input.name !== undefined;
  const colorKeyPresent = input.color !== undefined;
  const sortOrderKeyPresent = input.sortOrder !== undefined;
  if (!nameKeyPresent && !colorKeyPresent && !sortOrderKeyPresent) {
    throw new ValidationError('at least one of name, color, or sortOrder must be supplied');
  }

  const stored = await getOwnedCategory(ownerId, categoryId);
  if (!stored) throw new NotFoundError(`category ${categoryId} not found`);
  // Don't fight an in-progress deletion (the conditional update below also guards this).
  if (stored.deleting) {
    throw new ValidationError(`category ${categoryId} is being deleted and cannot be updated`);
  }

  // Validate the name change up front for clear errors.
  let name: string | undefined;
  if (nameKeyPresent) {
    if (stored.isDefault) throw new ValidationError('the default category cannot be renamed');
    if (input.name === null) throw new ValidationError('name cannot be null');
    name = input.name!.trim();
    if (!name) throw new ValidationError('name cannot be empty');
    if (isDefaultCategoryName(name)) {
      throw new ValidationError(`"${DEFAULT_CATEGORY_NAME}" is reserved for the default category`);
    }
  }

  const now = new Date().toISOString();
  const setParts = ['updatedAt = :now'];
  const removeParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':now': now };
  if (name != null) {
    setParts.push('#name = :name');
    names['#name'] = 'name'; // `name` is a DynamoDB reserved word
    values[':name'] = name;
  }
  if (colorKeyPresent) {
    if (input.color === null) removeParts.push('color');
    else {
      setParts.push('color = :color');
      values[':color'] = input.color!.trim();
    }
  }
  if (sortOrderKeyPresent) {
    if (input.sortOrder === null) removeParts.push('sortOrder');
    else {
      setParts.push('sortOrder = :sortOrder');
      values[':sortOrder'] = input.sortOrder;
    }
  }
  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length) updateExpression += ` REMOVE ${removeParts.join(', ')}`;

  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
        UpdateExpression: updateExpression,
        // Must still exist AND not have begun deletion since the pre-read.
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deleting)',
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripCategory(result.Attributes as Record<string, unknown>);
  } catch (err) {
    // Deletion started between the read and the write.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new ValidationError(`category ${categoryId} is being deleted and cannot be updated`);
    }
    throw err;
  }
}

/**
 * Delete one of the caller's own NON-default categories, reparenting its tasks first.
 *
 * Retry-safe, resumable, and SAFE despite the category GSI being eventually consistent (a
 * just-created Task may not appear in the GSI yet). A durable, transactionally-maintained
 * `taskCount` — not the GSI query — is the source of truth for "are there still tasks here":
 *  1) Flag the category `deleting: true`, so createTask / updateTask can no longer ATTACH
 *     tasks here (their increment Update is conditioned on `attribute_not_exists(deleting)`).
 *     `taskCount` is therefore monotonically non-increasing once flagged.
 *  2) Move every GSI-visible task to the owner's default category, decrementing this
 *     category's count and incrementing the default's — each in one transaction with the
 *     task write (so a count never drifts from reality).
 *  3) Strongly-consistent read the category. Only when `taskCount === 0` (proof no task
 *     still references it, even one the GSI hasn't surfaced) delete the row, conditioned on
 *     `taskCount = 0`. If the count is still positive, throw a retryable error — re-running
 *     reparents the now-visible tasks and converges. A Task is never left pointing at a
 *     deleted category.
 */
async function deleteCategory(
  identity: AppSyncIdentity | undefined,
  input: DeleteCategoryInput,
): Promise<Category> {
  const ownerId = requireCaller(identity);
  const categoryId = input?.categoryId?.trim();
  if (!categoryId) throw new ValidationError('categoryId is required and cannot be empty');

  const stored = await getOwnedCategory(ownerId, categoryId);
  if (!stored) throw new NotFoundError(`category ${categoryId} not found`);
  if (stored.isDefault) {
    throw new ValidationError('the default category cannot be deleted');
  }

  // The reparent target must exist before we start (fail clearly otherwise).
  const defaultCategoryId = await getDefaultCategoryId(ownerId);

  // 1) Block new attachments to this category for the duration of the deletion.
  if (!stored.deleting) {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
        UpdateExpression: 'SET deleting = :true, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
      }),
    );
  }

  // 2) Move every GSI-visible task out, adjusting both categories' counts atomically.
  await reparentTasks(ownerId, categoryId, defaultCategoryId);

  // 3) Strongly-consistent read: only delete once the durable count proves zero tasks.
  const fresh = await getOwnedCategory(ownerId, categoryId, { consistentRead: true });
  if (!fresh) return stripCategory(stored); // a concurrent retry already deleted it
  if (fresh.taskCount === undefined) {
    throw new ValidationError(
      `category ${categoryId} has no taskCount; run the category migration before deleting it`,
    );
  }
  if (fresh.taskCount > 0) {
    throw new Error(
      `deleteCategory: category ${categoryId} still has ${fresh.taskCount} task(s) being ` +
        'reparented (the category index may be catching up); retry the operation',
    );
  }

  // taskCount is 0 and can no longer increase (deleting flag blocks new attachments) — delete.
  try {
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
        ConditionExpression: 'attribute_exists(PK) AND taskCount = :zero',
        ExpressionAttributeValues: { ':zero': 0 },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new Error(
        `deleteCategory: category ${categoryId} gained a task during deletion; retry the operation`,
      );
    }
    throw err;
  }

  return stripCategory(fresh);
}

/**
 * Move every GSI-visible task in (ownerId, fromCategoryId) to toCategoryId. Each move is one
 * transaction: update the task's categoryId + denormalized taskCategoryKey (guarded by
 * `categoryId = :from`, so an already-moved row from the eventually-consistent index is a
 * safe no-op), decrement the source category's `taskCount`, and increment the default's.
 * Converges on retry; counts never drift from task placement.
 */
async function reparentTasks(
  ownerId: string,
  fromCategoryId: string,
  toCategoryId: string,
): Promise<void> {
  const fromKey = taskCategoryKey(ownerId, fromCategoryId);
  const toKey = taskCategoryKey(ownerId, toCategoryId);
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: TASK_CATEGORY_INDEX,
        KeyConditionExpression: 'taskCategoryKey = :key',
        ExpressionAttributeValues: { ':key': fromKey },
        ExclusiveStartKey: startKey,
      }),
    );
    const tasks = (page.Items as Task[]) ?? [];
    for (const task of tasks) {
      try {
        await dynamo.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: TABLE_NAME,
                  Key: { PK: taskPk(task.taskId), SK: META_SK },
                  UpdateExpression:
                    'SET categoryId = :to, taskCategoryKey = :toKey, updatedAt = :now',
                  ConditionExpression: 'attribute_exists(PK) AND categoryId = :from',
                  ExpressionAttributeValues: {
                    ':to': toCategoryId,
                    ':toKey': toKey,
                    ':from': fromCategoryId,
                    ':now': new Date().toISOString(),
                  },
                },
              },
              categoryCountDelta(ownerId, fromCategoryId, -1, { blockIfDeleting: false }),
              categoryCountDelta(ownerId, toCategoryId, 1, { blockIfDeleting: false }),
            ],
          }),
        );
      } catch (err) {
        // The task guard failed because the row was already moved (GSI lag / a prior retry).
        // That (and only that) is a safe no-op skip; anything else is a real failure.
        if (!isTaskAlreadyMoved(err)) throw err;
      }
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
}

/**
 * True when a reparent transaction was canceled SOLELY because the task's `categoryId = :from`
 * guard failed (the task was already moved) — a safe no-op to skip. A cancellation caused by
 * the count Updates (e.g. a missing category) is a real failure and must propagate.
 */
function isTaskAlreadyMoved(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  if (e?.name !== 'TransactionCanceledException') return false;
  const reasons = e.CancellationReasons;
  if (!reasons?.length) return false;
  // Item 0 is the task Update; items 1/2 are the source/default count Updates.
  const [taskReason, ...countReasons] = reasons;
  const taskGuardFailed = taskReason?.Code === 'ConditionalCheckFailed';
  const countsOk = countReasons.every((r) => !r?.Code || r.Code === 'None');
  return taskGuardFailed && countsOk;
}
