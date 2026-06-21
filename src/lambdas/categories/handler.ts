import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { categorySk, CATEGORY_PREFIX, ENTITY, userPk } from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, Category, Connection, CreateCategoryInput } from '../../shared/types';

/**
 * Categories domain Lambda — user-owned task categories (folder-like), routed by
 * the resolved GraphQL field. Categories share the USER#<ownerId> partition with
 * the owner's other rows; a CATEGORY# sort-key prefix keeps them queryable on their
 * own. One Lambda per domain mirrors the repo's existing handler layout.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Category | Connection<Category> | null> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createCategory':
      return createCategory(args.input as CreateCategoryInput);
    case 'listCategoriesByOwner':
      return listCategoriesByOwner(args.ownerId as string, pageArgs(args));
    default:
      throw new Error(`categories handler: unsupported field "${event.info?.fieldName}"`);
  }
};

async function createCategory(input: CreateCategoryInput): Promise<Category> {
  const ownerId = input?.ownerId?.trim();
  if (!ownerId) throw new ValidationError('ownerId is required and cannot be empty');
  if (!input?.name?.trim()) throw new ValidationError('name is required and cannot be empty');

  const categoryId = randomUUID();
  const now = new Date().toISOString();
  const category: Category = {
    categoryId,
    ownerId,
    name: input.name.trim(),
    color: input.color?.trim(),
    sortOrder: input.sortOrder,
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

async function listCategoriesByOwner(ownerId: string, page: PageArgs): Promise<Connection<Category>> {
  if (!ownerId?.trim()) throw new ValidationError('ownerId is required');
  // SK begins_with CATEGORY# scopes the USER#<ownerId> partition to category rows
  // (excludes #PROFILE, ASSIGN#, ASSIGN_STEP#, …).
  return queryPage<Category>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(ownerId.trim()), ':prefix': CATEGORY_PREFIX },
    },
    page,
  );
}
