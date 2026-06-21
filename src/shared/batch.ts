// Bulk-delete helpers for the single table.
//
// Used to remove a parent item together with all of its child rows (a Task and its
// TaskSteps, an Assignment and its AssignmentStep snapshots). DynamoDB's atomic
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
 * Collect the PK/SK of every row under `pk` whose SK begins with `skPrefix`,
 * following Query pagination so the result is complete regardless of row count.
 * Projects only the key attributes — the caller just needs keys to delete.
 */
export async function queryAllKeys(pk: string, skPrefix: string): Promise<ItemKey[]> {
  const keys: ItemKey[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': skPrefix },
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
