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

import { requireCaller } from './authz';
import { assertCanActForUser } from './delegation';
import { UnauthorizedError, ValidationError } from './response';
import type { AppSyncIdentity } from './types';

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
