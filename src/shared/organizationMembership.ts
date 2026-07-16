// Organization membership SESSIONS + the SupportLink lifecycle they control.
//
// A UserProfile carries an internal `organizationMembershipId` — a fresh UUID minted every
// time the user actually JOINS an organization (from none) or MOVES to a different one,
// removed when they LEAVE, and kept unchanged when organizationId is re-set to its current
// value. selectPrimaryUser snapshots both parties' membership ids onto the SupportLink, so
// delegated access can require the exact membership sessions the relationship was selected
// under — same-organization checking alone is NOT sufficient, because an old ACTIVE link
// would otherwise become effective again if both users later rejoined the same organization.
//
// This module owns:
//  - `planMembershipTransition` — the single decision table for what a profile write must do
//    to organizationMembershipId (keep / lazily initialize / rotate / clear) and whether the
//    org actually changed (⇒ affected ACTIVE SupportLinks must be revoked).
//  - `ensureOrganizationMembershipId` — concurrency-safe lazy initialization for legacy
//    profiles that have organizationId but no membership id (no migration/backfill exists;
//    legacy data is upgraded through normal runtime operations only).
//  - `revokeSupportLinksForOrganizationChange` — the shared, idempotent revocation sweep run
//    after every organization-membership change (updateMyUserProfile, repeated
//    createUserProfile, adminSetUserOrganization, adminDeleteOrganization member detach).
//
// Revocation is SOFT (status → REVOKED + a machine-readable reason); rows are never deleted,
// so an explicit selectPrimaryUser can restore the same link later. Rejoining never restores
// anything by itself: the rotated membership id already fails every stale link closed. The
// awaited, idempotent sweep reconciles stored status; if cleanup is interrupted, authorization
// remains closed because the membership snapshot is the authoritative boundary.

import { randomUUID } from 'crypto';
import { QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './dynamodb';
import {
  INCOMING_SUPPORT_LINK_PREFIX,
  PROFILE_SK,
  supporterPk,
  USER_LINK_PREFIX,
  userLinkSk,
  userPk,
} from './keys';
import { ValidationError } from './response';
import { isTransactConditionCheckFailure } from './organization';
import type { SupportLinkRevocationReason } from './types';

/** The revocation reason stamped by the organization-change sweep. */
export const ORG_MEMBERSHIP_CHANGED: SupportLinkRevocationReason = 'ORG_MEMBERSHIP_CHANGED';

/** Bound concurrent per-link transactions so large support histories finish without a request storm. */
const REVOCATION_CONCURRENCY = 10;

/** Mint a new organization membership session id. */
export const newOrganizationMembershipId = (): string => randomUUID();

/**
 * What one organization-membership write must do to the profile's membership session.
 * Exactly one of these comes back from `planMembershipTransition`:
 *  - `none`   — no org before or after: nothing to store, nothing changed.
 *  - `keep`   — organizationId is unchanged: keep the stored id; `membershipId` is the value
 *               to persist, and `initialized: true` flags that a legacy profile had none, so
 *               the caller must store it via a LAZY, if-absent write (never a blind overwrite,
 *               so concurrent initializers converge on one stable id). NOT an org change.
 *  - `rotate` — the user joined from no org or moved to a different org: store the fresh
 *               `membershipId` and, after the write commits, revoke stale ACTIVE links.
 *  - `clear`  — the user left their org: REMOVE the membership id and, after the write
 *               commits, revoke every ACTIVE link.
 */
export type MembershipTransition =
  | { kind: 'none'; organizationChanged: false }
  | { kind: 'keep'; organizationChanged: false; membershipId: string; initialized: boolean }
  | { kind: 'rotate'; organizationChanged: true; membershipId: string }
  | { kind: 'clear'; organizationChanged: true };

/**
 * Decide the membership-session effect of writing `nextOrganizationId` over a profile whose
 * pre-read state was (`previousOrganizationId`, `previousMembershipId`). Pure — the caller
 * applies the result with its own write shape (Update / full Put / transaction).
 */
export function planMembershipTransition(
  previousOrganizationId: string | undefined,
  previousMembershipId: string | undefined,
  nextOrganizationId: string | undefined,
): MembershipTransition {
  const prev = previousOrganizationId?.trim() || undefined;
  const next = nextOrganizationId?.trim() || undefined;
  if (!prev && !next) return { kind: 'none', organizationChanged: false };
  if (!next) return { kind: 'clear', organizationChanged: true };
  if (prev === next) {
    // Same organization: never rotate an existing id; a legacy profile without one is
    // initialized lazily (if-absent) — an unchanged org is NOT a leave-and-rejoin.
    return previousMembershipId
      ? {
          kind: 'keep',
          organizationChanged: false,
          membershipId: previousMembershipId,
          initialized: false,
        }
      : {
          kind: 'keep',
          organizationChanged: false,
          membershipId: newOrganizationMembershipId(),
          initialized: true,
        };
  }
  return { kind: 'rotate', organizationChanged: true, membershipId: newOrganizationMembershipId() };
}

/**
 * Lazily initialize a legacy profile's missing organizationMembershipId and return the
 * AUTHORITATIVE stored value. Concurrency-safe: `if_not_exists` resolves inside DynamoDB, so
 * concurrent initializers all converge on the one id that won, and an id that already exists
 * is never rotated. The write is conditioned on the profile still being in `organizationId`
 * (it must never resurrect a membership the user concurrently left/changed) and preserves the
 * organizationId and every other field; a lost race throws the repository-standard
 * "changed concurrently" ValidationError so the caller can re-read and retry.
 */
export async function ensureOrganizationMembershipId(
  userId: string,
  organizationId: string,
): Promise<string> {
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: PROFILE_SK },
        UpdateExpression:
          'SET organizationMembershipId = if_not_exists(organizationMembershipId, :fresh)',
        ConditionExpression: 'attribute_exists(PK) AND organizationId = :org',
        ExpressionAttributeValues: {
          ':fresh': newOrganizationMembershipId(),
          ':org': organizationId,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const stored = (result.Attributes as { organizationMembershipId?: string } | undefined)
      ?.organizationMembershipId;
    if (!stored) throw new Error(`profile ${userId} has no organizationMembershipId after init`);
    return stored;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new ValidationError(
        `user ${userId}'s organization membership changed concurrently; re-read and retry`,
      );
    }
    throw err;
  }
}

/** One SupportLink row's base-table key plus the fields the revocation sweep reads. */
interface SupportLinkRow {
  PK: string;
  SK: string;
}

/** The authoritative profile state a post-change revocation sweep is bound to. */
export interface OrganizationMembershipState {
  organizationId?: string;
  organizationMembershipId?: string;
}

/**
 * Soft-revoke every ACTIVE SupportLink affected by `userId`'s organization-membership change,
 * in BOTH directions: links where they are the SUPPORTER (their SUPPORTER#<id> partition) and
 * links where they are the PRIMARY user (durable reverse pointers in their USER# partition).
 * Both are base-table reads, so a just-selected relationship cannot be missed through GSI lag.
 * Runs AFTER the profile write commits. Per link it flips status → REVOKED, stamps `revokedReason:
 * ORG_MEMBERSHIP_CHANGED`, bumps updatedAt, and preserves createdAt + every other field.
 *
 * `expectedState` is the profile state AFTER the change. Every per-link revocation transaction
 * condition-checks that the profile is STILL in exactly that state. This prevents a delayed
 * sweep from an older transition (A→B or leave) from revoking a link explicitly selected after
 * a later transition (B→C or rejoin). A link whose snapshot already equals the expected current
 * membership was selected under the new session and is left alone; everything else — including
 * legacy links with no snapshot — is stale and revoked.
 *
 * Idempotent and retry-safe: the queries follow pagination (never a Scan, safe for many
 * links), each revocation is its own small profile-guarded transaction (no transaction/batch-size
 * ceiling to respect), already-REVOKED links are filtered out and additionally guarded by the
 * update's `status = ACTIVE` condition (they are never rewritten or reactivated), and a
 * missing row is never created (`attribute_exists(PK)`). Returns how many links were revoked.
 */
export async function revokeSupportLinksForOrganizationChange(
  userId: string,
  expectedState: OrganizationMembershipState,
): Promise<number> {
  if (!!expectedState.organizationId !== !!expectedState.organizationMembershipId) {
    throw new Error(
      'revokeSupportLinksForOrganizationChange requires organizationId and ' +
        'organizationMembershipId together, or neither after a leave',
    );
  }
  const [outgoing, incoming] = await Promise.all([
    // Outgoing: the changing user is the supporter — their own SUPPORTER# partition.
    queryActiveLinkRows({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      // This is a base-table security/lifecycle read; observe every pre-change link immediately.
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ':pk': supporterPk(userId),
        ':prefix': USER_LINK_PREFIX,
        ':active': 'ACTIVE',
      },
    }),
    // Incoming: selection atomically writes a reverse pointer into the primary user's USER#
    // partition. Query those pointers consistently, then target the canonical SUPPORTER# rows.
    queryIncomingLinkRows(userId),
  ]);

  const [outgoingRevoked, incomingRevoked] = await Promise.all([
    revokeRowsWithBoundedConcurrency(
      userId,
      outgoing,
      'supporterOrganizationMembershipId',
      expectedState,
    ),
    revokeRowsWithBoundedConcurrency(
      userId,
      incoming,
      'primaryUserOrganizationMembershipId',
      expectedState,
    ),
  ]);
  return outgoingRevoked + incomingRevoked;
}

/** Revoke one direction in bounded parallel chunks; one transient failure rejects the sweep. */
async function revokeRowsWithBoundedConcurrency(
  userId: string,
  rows: SupportLinkRow[],
  snapshotField: 'supporterOrganizationMembershipId' | 'primaryUserOrganizationMembershipId',
  expectedState: OrganizationMembershipState,
): Promise<number> {
  let revoked = 0;
  for (let i = 0; i < rows.length; i += REVOCATION_CONCURRENCY) {
    const results = await Promise.all(
      rows
        .slice(i, i + REVOCATION_CONCURRENCY)
        .map((row) => revokeLinkIfStale(userId, row, snapshotField, expectedState)),
    );
    revoked += results.filter(Boolean).length;
  }
  return revoked;
}

interface IncomingSupportLinkPointer {
  supporterId?: string;
}

/** Resolve every durable incoming pointer to its canonical SupportLink base-table key. */
async function queryIncomingLinkRows(primaryUserId: string): Promise<SupportLinkRow[]> {
  const rows: SupportLinkRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ':pk': userPk(primaryUserId),
          ':prefix': INCOMING_SUPPORT_LINK_PREFIX,
        },
        ProjectionExpression: 'supporterId',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const pointer of (result.Items as IncomingSupportLinkPointer[]) ?? []) {
      const supporterId = pointer.supporterId?.trim();
      if (supporterId) {
        rows.push({ PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) });
      }
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return rows;
}

/** Query one side's ACTIVE SupportLink rows (keys only), following pagination to completion. */
async function queryActiveLinkRows(
  query: Pick<
    ConstructorParameters<typeof QueryCommand>[0],
    'IndexName' | 'KeyConditionExpression' | 'ExpressionAttributeValues' | 'ConsistentRead'
  >,
): Promise<SupportLinkRow[]> {
  const rows: SupportLinkRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        ...query,
        FilterExpression: '#status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        // Canonical SupportLink rows are addressed by their base-table PK/SK.
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (result.Items as SupportLinkRow[]) ?? []) {
      rows.push({ PK: item.PK, SK: item.SK });
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return rows;
}

/**
 * Conditionally revoke ONE link. `snapshotField` is the changing user's side of the membership
 * snapshot; with a `currentMembershipId`, a link already selected under it is skipped. The
 * profile ConditionCheck binds the transaction to the transition that scheduled the sweep, while
 * `status = ACTIVE` + `attribute_exists(PK)` makes a lost link race (already revoked, deleted,
 * or freshly re-selected) a clean no-op. Either condition failure is swallowed, so the sweep is
 * idempotent and safe to retry.
 */
async function revokeLinkIfStale(
  userId: string,
  row: SupportLinkRow,
  snapshotField: 'supporterOrganizationMembershipId' | 'primaryUserOrganizationMembershipId',
  expectedState: OrganizationMembershipState,
): Promise<boolean> {
  const currentMembershipId = expectedState.organizationMembershipId;
  const staleGuard = currentMembershipId
    ? ` AND (attribute_not_exists(${snapshotField}) OR ${snapshotField} <> :currentMid)`
    : '';
  const profileCondition = expectedState.organizationId
    ? 'attribute_exists(PK) AND organizationId = :expectedOrg AND organizationMembershipId = :expectedMid'
    : 'attribute_exists(PK) AND attribute_not_exists(organizationId) AND attribute_not_exists(organizationMembershipId)';
  const profileValues = expectedState.organizationId
    ? {
        ':expectedOrg': expectedState.organizationId,
        ':expectedMid': expectedState.organizationMembershipId,
      }
    : undefined;
  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // Bind this cleanup attempt to the transition that scheduled it. If the user has
            // moved again, the sweep is obsolete and must not touch a newer explicit selection.
            ConditionCheck: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(userId), SK: PROFILE_SK },
              ConditionExpression: profileCondition,
              ...(profileValues ? { ExpressionAttributeValues: profileValues } : {}),
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: row.PK, SK: row.SK },
              UpdateExpression: 'SET #status = :revoked, revokedReason = :reason, updatedAt = :now',
              ConditionExpression: `attribute_exists(PK) AND #status = :active${staleGuard}`,
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':revoked': 'REVOKED',
                ':active': 'ACTIVE',
                ':reason': ORG_MEMBERSHIP_CHANGED,
                ':now': new Date().toISOString(),
                ...(currentMembershipId ? { ':currentMid': currentMembershipId } : {}),
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    // [0] profile moved again → this sweep is obsolete. [1] link was already revoked/deleted or
    // was explicitly selected under the expected new session → no work for this row.
    if (isTransactConditionCheckFailure(err, 0) || isTransactConditionCheckFailure(err, 1)) {
      return false;
    }
    throw err;
  }
}
