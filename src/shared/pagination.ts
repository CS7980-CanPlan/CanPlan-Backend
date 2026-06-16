// Opaque pagination tokens for DynamoDB Query pagination.
//
// A DynamoDB `LastEvaluatedKey` is a small key object; we expose it to clients as a
// base64 string so the key shape stays an implementation detail and round-trips
// cleanly through GraphQL `nextToken` arguments.

import { ValidationError } from './response';

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
