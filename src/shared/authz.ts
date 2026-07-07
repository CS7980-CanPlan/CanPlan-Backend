// Authorization helpers for AppSync Lambda resolvers.
//
// Identity-scoped ownership: the authenticated caller's Cognito `sub` is the source of
// truth for "who am I", and `assertCallerOwns` enforces that a resource's `ownerId` equals
// that `sub` — the strict self-ownership primitive (e.g. createTaskAssignment requires the
// caller to own the referenced Task template).
//
// Delegated access — a SupportPerson acting for a selected PRIMARY_USER — is layered on top
// in `delegation.ts` (`assertCanActForUser` / `assertCanReadTask`); this module only provides
// the self-ownership building blocks (`requireCaller`, `assertCallerOwns`).

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
