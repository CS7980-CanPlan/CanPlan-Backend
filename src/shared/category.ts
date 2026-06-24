// Category lookup + Task↔Category integrity helpers shared by createTask and the tasks
// Lambda. Categories are private to their owner (PK = USER#<ownerId>, SK =
// CATEGORY#<categoryId>), so "owned by ownerId" is enforced simply by reading under the
// owner's partition — a foreign category id is never found here.

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './dynamodb';
import { categorySk, DEFAULT_CATEGORY_NAME, PROFILE_SK, userPk } from './keys';
import { NotFoundError, ValidationError } from './response';
import type { Category, UserProfile } from './types';

/** Read one of an owner's categories (undefined if it doesn't exist for that owner). */
export async function getOwnedCategory(
  ownerId: string,
  categoryId: string,
  options: { consistentRead?: boolean } = {},
): Promise<Category | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
      ConsistentRead: options.consistentRead,
    }),
  );
  return result.Item as Category | undefined;
}

/**
 * Resolve an owner's default category id from their profile, fully validating that the
 * referenced Category row is a real, usable default before returning it. The profile pointer
 * alone is not trusted: the Category is read with a STRONGLY-CONSISTENT read and must exist,
 * be owned by `ownerId`, be `isDefault`, carry the reserved name, and not be mid-deletion.
 * Any failure is a hard error directing the operator to the migration — we never invent
 * category data or file a Task under an invalid/missing default.
 */
export async function getDefaultCategoryId(ownerId: string): Promise<string> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(ownerId), SK: PROFILE_SK } }),
  );
  const profile = result.Item as UserProfile | undefined;
  if (!profile) {
    throw new ValidationError(
      `owner ${ownerId} has no user profile; create the profile before creating tasks`,
    );
  }
  const defaultCategoryId = profile.defaultCategoryId;
  if (!defaultCategoryId) {
    throw new ValidationError(
      `owner ${ownerId} has no default category; run the category migration for this profile`,
    );
  }
  // Strongly-consistent so we never act on a stale/just-repaired pointer.
  const category = await getOwnedCategory(ownerId, defaultCategoryId, { consistentRead: true });
  if (
    !category ||
    category.ownerId !== ownerId ||
    category.isDefault !== true ||
    // The stored default name must be canonical, not merely an equivalent spelling.
    // `isDefaultCategoryName` stays lenient when rejecting user input, but legacy values
    // such as " no category " must be repaired by the migration.
    category.name !== DEFAULT_CATEGORY_NAME ||
    category.deleting
  ) {
    throw new ValidationError(
      `owner ${ownerId}'s default category (${defaultCategoryId}) is missing or invalid; ` +
        'run the category migration to repair it',
    );
  }
  return defaultCategoryId;
}

/**
 * Validate that `categoryId` is a real category owned by `ownerId` and not mid-deletion,
 * returning it. Throws NotFoundError (missing/foreign owner) or ValidationError (being
 * deleted). This is the pre-read check; pair it with `categoryConditionCheck` in the
 * write transaction so the category can't be deleted between the read and the write.
 */
export async function assertUsableCategory(ownerId: string, categoryId: string): Promise<Category> {
  const category = await getOwnedCategory(ownerId, categoryId);
  if (!category) {
    throw new NotFoundError(`category ${categoryId} not found for owner ${ownerId}`);
  }
  if (category.deleting) {
    throw new ValidationError(`category ${categoryId} is being deleted and cannot be used`);
  }
  return category;
}

/**
 * A TransactWriteItem `Update` that adjusts a category's durable `taskCount` by `delta`
 * (+1 when a Task joins the category, -1 when it leaves) — included in the SAME transaction
 * as the Task write so the count can never drift from reality.
 *
 * `blockIfDeleting`: when true (a Task is *joining* the category), the update also asserts
 * the category exists and is **not** flagged for deletion — so a concurrent `deleteCategory`
 * can't attach a Task to a category that's being removed (and the count stays correct). When
 * false (a Task is *leaving* — delete/reparent-source), only existence is required, so a Task
 * can always be moved out of a deleting category.
 */
export function categoryCountDelta(
  ownerId: string,
  categoryId: string,
  delta: 1 | -1,
  options: { blockIfDeleting: boolean },
) {
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
      UpdateExpression: 'SET #updatedAt = :now ADD #taskCount :delta',
      ConditionExpression: options.blockIfDeleting
        ? 'attribute_exists(PK) AND attribute_not_exists(deleting)'
        : 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#taskCount': 'taskCount', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':delta': delta, ':now': new Date().toISOString() },
    },
  };
}
