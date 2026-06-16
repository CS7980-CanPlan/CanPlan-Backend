// Opaque pagination tokens + a paginated Query helper for DynamoDB.
//
// A DynamoDB `LastEvaluatedKey` is a small key object; we expose it to clients as a
// base64 string so the key shape stays an implementation detail and round-trips
// cleanly through GraphQL `nextToken` arguments.

import { QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { dynamo } from './dynamodb';
import { ValidationError } from './response';
import type { Connection } from './types';

/** Optional pagination arguments shared by every list query. */
export interface PageArgs {
  limit?: number;
  nextToken?: string;
}

/** Encode a DynamoDB LastEvaluatedKey as an opaque token; null when there's no next page. */
export function encodeNextToken(key?: Record<string, unknown>): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
}

/** Decode a client nextToken back into a DynamoDB ExclusiveStartKey (undefined if absent). */
export function decodeNextToken(token?: string | null): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    throw new ValidationError('invalid nextToken');
  }
}

/** Pull `limit`/`nextToken` out of a resolver's arguments map. */
export function pageArgs(args: Record<string, unknown>): PageArgs {
  return {
    limit: typeof args.limit === 'number' ? args.limit : undefined,
    nextToken: typeof args.nextToken === 'string' ? args.nextToken : undefined,
  };
}

/**
 * Run a DynamoDB Query with opaque-token pagination and return a Connection.
 * The caller supplies the query shape (table/index, key condition, etc.); this
 * injects Limit + ExclusiveStartKey and encodes the LastEvaluatedKey as nextToken.
 */
export async function queryPage<T>(
  input: Omit<QueryCommandInput, 'Limit' | 'ExclusiveStartKey'>,
  { limit, nextToken }: PageArgs = {},
): Promise<Connection<T>> {
  const result = await dynamo.send(
    new QueryCommand({
      ...input,
      Limit: typeof limit === 'number' && limit > 0 ? limit : undefined,
      ExclusiveStartKey: decodeNextToken(nextToken),
    }),
  );
  return {
    items: (result.Items as T[]) ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey),
  };
}
