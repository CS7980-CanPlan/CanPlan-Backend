// Organization lookup + integrity helpers shared by the admin Lambda and the user-profile
// membership writes. An Organization is a real persisted row (PK = ORG#<organizationId>,
// SK = #META, entityType = Organization) that a UserProfile.organizationId references —
// membership is no longer a free-form string. Created/renamed/deleted only by SystemAdmin
// admin APIs; PrimaryUser and SupportPerson may READ the joinable directory via the users
// Lambda's listAvailableOrganizations / getOrganization.

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './dynamodb';
import { ENTITY, META_SK, organizationMemberSk, organizationPk } from './keys';
import { NotFoundError, ValidationError } from './response';
import type { Organization } from './types';

/** Read one Organization #META row (undefined if it doesn't exist). */
export async function getOrganization(organizationId: string): Promise<Organization | undefined> {
  const id = organizationId?.trim();
  if (!id) return undefined;
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: organizationPk(id), SK: META_SK },
      // Join checks and the public directory must immediately observe the deleting marker.
      ConsistentRead: true,
    }),
  );
  return result.Item as Organization | undefined;
}

/**
 * Validate that `organizationId` names a real Organization that is not mid-deletion, returning
 * the (stripped) row. Throws ValidationError for a blank id, NotFoundError when no such org
 * exists, and ValidationError when the org is being deleted. Use this before persisting any
 * UserProfile.organizationId so membership can only ever point at a usable organization.
 */
export async function assertUsableOrganization(organizationId: string): Promise<Organization> {
  const id = organizationId?.trim();
  if (!id) throw new ValidationError('organizationId is required and cannot be empty');
  const organization = await getOrganization(id);
  if (!organization) {
    throw new NotFoundError(`organization ${id} not found`);
  }
  if (organization.deleting) {
    throw new ValidationError(`organization ${id} is being deleted and cannot be joined`);
  }
  return stripOrganization(organization);
}

/** Strip internal storage/GSI attributes (PK/SK/entityType/deleting) before returning an Organization. */
export function stripOrganization(item: Organization | Record<string, unknown>): Organization {
  const out: Record<string, unknown> = { ...item };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  delete out.deleting;
  return out as unknown as Organization;
}

/**
 * A TransactWrite `ConditionCheck` asserting the organization still exists and is NOT being
 * deleted. Include it in the SAME transaction as any write that sets a UserProfile.organizationId,
 * so membership can never be persisted for an org a concurrent adminDeleteOrganization is
 * removing — closing the race between a pre-read (assertUsableOrganization) and the write.
 */
export function organizationConditionCheck(organizationId: string) {
  return {
    ConditionCheck: {
      TableName: TABLE_NAME,
      Key: { PK: organizationPk(organizationId), SK: META_SK },
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deleting)',
    },
  };
}

/**
 * True when a TransactWrite was canceled specifically because the transact item at `index` failed
 * its ConditionExpression (AWS populates `CancellationReasons` positionally per transact item, each
 * `Code` being `'None'` or `'ConditionalCheckFailed'`). This distinguishes an intended conditional
 * failure — e.g. the organization ConditionCheck (the org was deleted mid-write) or a member's
 * "still in this org" guard — from OTHER cancellations (TransactionConflict, throttling, …), which
 * are transient and must be rethrown so a caller/retry doesn't mistake them for the expected case.
 */
export function isTransactConditionCheckFailure(err: unknown, index: number): boolean {
  const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string } | undefined> };
  if (e?.name !== 'TransactionCanceledException') return false;
  return e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';
}

/**
 * A TransactWrite `Put` for the strongly-consistent OrganizationMember row (PK = ORG#<org>,
 * SK = MEMBER#<user>, entityType = OrganizationMember). Write it in the SAME transaction as any
 * UserProfile.organizationId set, so the org partition always lists its current members — the
 * source of truth adminDeleteOrganization reads with a consistent Query (the orgIndex GSI is only
 * eventually consistent and could miss a just-joined member). Idempotent: re-joining the same org
 * simply overwrites the row.
 */
export function organizationMemberPut(organizationId: string, userId: string) {
  const now = new Date().toISOString();
  return {
    Put: {
      TableName: TABLE_NAME,
      Item: {
        PK: organizationPk(organizationId),
        SK: organizationMemberSk(userId),
        entityType: ENTITY.ORGANIZATION_MEMBER,
        organizationId,
        userId,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

/**
 * A TransactWrite `Delete` for an OrganizationMember row — used when a UserProfile leaves or moves
 * organizations so the previous org's membership list drops the stale entry. Unconditional, hence
 * idempotent (deleting an already-absent row is a no-op).
 */
export function organizationMemberDelete(organizationId: string, userId: string) {
  return {
    Delete: {
      TableName: TABLE_NAME,
      Key: { PK: organizationPk(organizationId), SK: organizationMemberSk(userId) },
    },
  };
}
