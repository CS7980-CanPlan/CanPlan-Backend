// Bulk-delete helpers for the single table.
//
// Used to remove a parent item together with all of its child rows (a Task and its
// TaskSteps, or a full USER# partition). DynamoDB's atomic
// TransactWrite is capped at 100 items, so an entity with >99 children cannot be
// deleted in one transaction. These helpers instead collect every child key (following
// Query pagination) and delete in BatchWriteItem chunks — non-transactional, but it
// scales past the 100-item ceiling. See each caller for the ordering it relies on.

import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './dynamodb';

/** DynamoDB BatchWriteItem accepts at most 25 write requests per call. */
export const BATCH_WRITE_LIMIT = 25;

/** A bare composite primary key (the only attributes a delete needs). */
export interface ItemKey {
  PK: string;
  SK: string;
}

/**
 * Collect the PK/SK of every row under `pk`, following Query pagination so the result
 * is complete regardless of row count. With `skPrefix` only rows whose SK begins with it
 * are returned; omit it to collect EVERY row in the partition (e.g. an entire USER#<id>
 * partition for a full user deletion). Projects only the key attributes.
 */
export async function queryAllKeys(pk: string, skPrefix?: string): Promise<ItemKey[]> {
  const keys: ItemKey[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: skPrefix
          ? 'PK = :pk AND begins_with(SK, :prefix)'
          : 'PK = :pk',
        ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':prefix': skPrefix } : { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (result.Items as ItemKey[]) ?? []) {
      keys.push({ PK: item.PK, SK: item.SK });
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return keys;
}

/**
 * Run an arbitrary Query, following pagination so the result is complete regardless of row
 * count. The caller supplies the full QueryCommand input (table, key condition, any
 * index/filter/projection); `ExclusiveStartKey` is threaded here. Use this for queries that
 * `queryAllItems` can't express — a GSI lookup, a FilterExpression, etc.
 */
export async function queryAll<T>(
  input: ConstructorParameters<typeof QueryCommand>[0],
): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...((result.Items as T[]) ?? []));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

/**
 * Collect every full item under `pk` whose SK begins with `skPrefix`, following Query
 * pagination. Unlike `queryAllKeys` this returns the whole row (e.g. so a cascade delete
 * can read each MediaAsset's `s3Key`), at the cost of reading every attribute.
 */
export async function queryAllItems<T>(pk: string, skPrefix: string): Promise<T[]> {
  return queryAll<T>({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': pk, ':prefix': skPrefix },
  });
}

/**
 * Delete many items by key in BatchWriteItem chunks of 25, retrying any
 * UnprocessedItems DynamoDB hands back under throttling (capacity pressure, not a
 * logical failure). This is NOT transactional: chunks commit independently, so a
 * mid-run failure can leave some keys deleted and others not. Callers must therefore
 * order deletes so a partial run is safe (delete children before their parent) and
 * treat the whole operation as idempotently retryable. Throws if a chunk still has
 * unprocessed items after the retry budget — surfacing the partial delete rather than
 * silently dropping rows.
 */
export async function batchDelete(keys: ItemKey[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH_WRITE_LIMIT) {
    const chunk = keys.slice(i, i + BATCH_WRITE_LIMIT);
    let requestItems: NonNullable<
      ConstructorParameters<typeof BatchWriteCommand>[0]['RequestItems']
    > = {
      [TABLE_NAME]: chunk.map(({ PK, SK }) => ({ DeleteRequest: { Key: { PK, SK } } })),
    };
    // Bounded retry for throttling-driven UnprocessedItems (no infinite loop).
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await dynamo.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unprocessed = result.UnprocessedItems;
      if (!unprocessed?.[TABLE_NAME]?.length) {
        requestItems = {};
        break;
      }
      requestItems = unprocessed;
    }
    if (requestItems[TABLE_NAME]?.length) {
      throw new Error(
        `batchDelete: ${requestItems[TABLE_NAME].length} item(s) still unprocessed after retries`,
      );
    }
  }
}

/**
 * Write many complete rows with BatchWriteItem, in 25-item chunks and with the same
 * bounded retry policy as batchDelete. Journal rows use this before a cascade deletes
 * the source metadata, so a later retry still knows which S3 objects to clean up.
 */
export async function batchPut(items: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_WRITE_LIMIT) {
    const chunk = items.slice(i, i + BATCH_WRITE_LIMIT);
    let requestItems: NonNullable<
      ConstructorParameters<typeof BatchWriteCommand>[0]['RequestItems']
    > = {
      [TABLE_NAME]: chunk.map((Item) => ({ PutRequest: { Item } })),
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await dynamo.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unprocessed = result.UnprocessedItems;
      if (!unprocessed?.[TABLE_NAME]?.length) {
        requestItems = {};
        break;
      }
      requestItems = unprocessed;
    }
    if (requestItems[TABLE_NAME]?.length) {
      throw new Error(
        `batchPut: ${requestItems[TABLE_NAME].length} item(s) still unprocessed after retries`,
      );
    }
  }
}
