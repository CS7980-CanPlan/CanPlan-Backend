// Authorization helpers for AppSync Lambda resolvers.
//
// Identity-scoped ownership: the authenticated caller's Cognito `sub` is the source of
// truth for "who am I", and a resource owned by some `ownerId` may only be operated on by
// the caller whose `sub` equals that `ownerId`. There is no delegated-role model yet, so
// this is a strict self-ownership check. (Assignment authorization is intentionally out of
// scope here.)

import { UnauthorizedError } from './response';
import type { AppSyncIdentity } from './types';

/** The authenticated caller's id (Cognito `sub`), or an UnauthorizedError when absent. */
export function requireCaller(identity: AppSyncIdentity | undefined): string {
  const sub = identity?.sub?.trim();
  if (!sub) throw new UnauthorizedError('Unauthorized: an authenticated user is required');
  return sub;
}

/**
 * Assert the authenticated caller owns the resource (caller `sub` === `ownerId`). Returns
 * the caller id. Throws UnauthorizedError for an unauthenticated caller or a foreign owner.
 */
export function assertCallerOwns(identity: AppSyncIdentity | undefined, ownerId: string): string {
  const sub = requireCaller(identity);
  if (sub !== ownerId) {
    throw new UnauthorizedError('Unauthorized: caller does not own this resource');
  }
  return sub;
}
