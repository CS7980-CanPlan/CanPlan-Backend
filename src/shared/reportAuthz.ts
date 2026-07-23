/**
 * Authorization seam for the reports feature — the single choke point guarding
 * generateReport, saveReport, listReports, getReportDownloadUrl, and deleteReport.
 *
 * Reports are a SUPPORT-PERSON surface: a caller may only touch a primary user's reports as
 * that user's currently effective supporter. Concretely, access is granted only when ALL hold:
 *   - the caller is in the Cognito `SupportPerson` group,
 *   - the caller holds an ACTIVE SupportLink to the target user,
 *   - the target is still a `PRIMARY_USER`, and
 *   - both parties currently share an organization and the link's organization/membership
 *     snapshot still matches both live profiles.
 * A primary user may NOT access their own reports (self-access is explicitly denied) — reports
 * are produced for a supporter, not the subject. This mirrors the delegation rules enforced for
 * every other cross-user operation (see assertCanActForUser), minus the self path.
 */

import { batchGet, queryAll } from './batch';
import { requireCaller } from './authz';
import { assertCanActForUser, loadProfile, supportLinkIneffectiveReason } from './delegation';
import { TABLE_NAME } from './dynamodb';
import { PROFILE_SK, supporterPk, USER_LINK_PREFIX, userPk } from './keys';
import { UnauthorizedError, ValidationError } from './response';
import { isSupportPerson } from './roles';
import type { AppSyncIdentity, SupportLink, UserProfile } from './types';

/**
 * Assert the caller may access `targetUserId`'s reports and return the caller's id (Cognito
 * `sub`). Throws UnauthorizedError when the caller is unauthenticated, is the target themselves,
 * or lacks effective SupportPerson delegation to the target.
 */
export async function assertCanAccessUserReports(
  identity: AppSyncIdentity | undefined,
  targetUserId: string,
): Promise<string> {
  const caller = requireCaller(identity);
  const target = targetUserId?.trim();
  if (!target) throw new ValidationError('userId is required and cannot be empty');

  // Reports are a supporter-only surface: a primary user cannot generate or read their own.
  if (caller === target) {
    throw new UnauthorizedError(
      'Unauthorized: report operations are restricted to a support person acting for a primary ' +
        'user (a user cannot access their own reports)',
    );
  }

  // assertCanActForUser enforces the full effective-link rule (ACTIVE, PRIMARY_USER target,
  // shared organization, and matching membership snapshot) and rejects non-SupportPerson
  // callers; reusing it keeps reports in lock-step with every other cross-user operation.
  await assertCanActForUser(identity, target);
  return caller;
}

/**
 * Resolve every primary user whose reports the caller may access RIGHT NOW.
 *
 * This is the collection form of {@link assertCanAccessUserReports}: it starts from the
 * authenticated SupportPerson's natural SUPPORTER# partition, then applies the exact same
 * effective-link predicate used by delegated access. Reads are strongly consistent so a link
 * revoked immediately before this call cannot remain visible through an eventually-consistent
 * index image. Target profiles are BatchGot to avoid an N+1 read pattern.
 *
 * The sorted result is deliberately just user ids. Report storage uses those ids as the only
 * partitions it is allowed to query, so no unrelated user's report metadata is ever read.
 */
export async function listAccessibleReportUserIds(
  identity: AppSyncIdentity | undefined,
): Promise<string[]> {
  const caller = requireCaller(identity);
  if (!isSupportPerson(identity)) {
    throw new UnauthorizedError(
      'Unauthorized: report operations are restricted to a support person acting for a primary user',
    );
  }

  const supporter = await loadProfile(caller);
  if (!supporter) return [];

  const links = await queryAll<SupportLink>({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ConsistentRead: true,
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pk': supporterPk(caller),
      ':prefix': USER_LINK_PREFIX,
      ':active': 'ACTIVE',
    },
  });
  if (links.length === 0) return [];

  const targetIds = [...new Set(links.map((link) => link.primaryUserId.trim()).filter(Boolean))];
  if (targetIds.length === 0) return [];

  const profiles = (await batchGet(
    targetIds.map((userId) => ({ PK: userPk(userId), SK: PROFILE_SK })),
  )) as unknown as UserProfile[];
  const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));

  return links
    .filter(
      (link) =>
        supportLinkIneffectiveReason(link, supporter, profilesByUserId.get(link.primaryUserId)) ===
        null,
    )
    .map((link) => link.primaryUserId)
    .filter((userId, index, all) => all.indexOf(userId) === index)
    .sort();
}
