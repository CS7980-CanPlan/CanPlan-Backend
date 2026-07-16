// Cognito group authorization helpers for AppSync Lambda resolvers.

import { UnauthorizedError } from './response';
import type { AppSyncIdentity } from './types';

/**
 * The caller's Cognito groups. AppSync surfaces them on `identity.groups` for
 * User Pool auth; we also fall back to the raw `cognito:groups` JWT claim.
 */
export function getGroups(identity?: AppSyncIdentity): string[] {
  if (!identity) return [];
  if (Array.isArray(identity.groups)) return identity.groups;
  const claim = identity.claims?.['cognito:groups'];
  return Array.isArray(claim) ? (claim as string[]) : [];
}

/** Throw UnauthorizedError unless the caller belongs to the given Cognito group. */
export function requireGroup(identity: AppSyncIdentity | undefined, group: string): void {
  if (!getGroups(identity).includes(group)) {
    throw new UnauthorizedError(`Unauthorized: ${group} access required`);
  }
}

/**
 * Throw UnauthorizedError unless the caller belongs to AT LEAST ONE of the given Cognito
 * groups. The Lambda-side half of defense-in-depth for fields whose AppSync directive lists
 * several allowed groups (e.g. the PrimaryUser/SupportPerson organization directory) — never
 * rely on the GraphQL directive alone.
 */
export function requireAnyGroup(
  identity: AppSyncIdentity | undefined,
  groups: readonly string[],
): void {
  const memberships = getGroups(identity);
  if (!groups.some((group) => memberships.includes(group))) {
    throw new UnauthorizedError(`Unauthorized: one of [${groups.join(', ')}] access required`);
  }
}
