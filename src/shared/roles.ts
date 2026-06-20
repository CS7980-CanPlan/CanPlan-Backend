// Maps Cognito group membership — the source of truth for authorization — onto the
// UserProfile.role domain projection used by business queries and DynamoDB indexes.

import { getGroups } from './auth';
import { ValidationError } from './response';
import type { AppSyncIdentity, UserRole } from './types';

/**
 * The three mutually-exclusive base business roles. `SystemAdmin` is deliberately
 * absent: it's an elevated authorization group, not a UserRole, and stays
 * group-gated at the AppSync edge — never projected into UserProfile.role.
 */
const GROUP_TO_ROLE: Readonly<Record<string, UserRole>> = {
  PrimaryUser: 'PRIMARY_USER',
  SupportPerson: 'SUPPORT_PERSON',
  OrganizationAdmin: 'ORG_ADMIN',
};

/**
 * Derive the caller's `UserRole` from their Cognito groups. Exactly one base-role
 * group must be present — zero or multiple is rejected with a clear validation
 * error rather than guessing. Non-base groups (e.g. SystemAdmin) are ignored, so a
 * SystemAdmin with no base role does not map to a business UserRole.
 */
export function roleFromIdentity(identity: AppSyncIdentity | undefined): UserRole {
  const roles = [
    ...new Set(getGroups(identity).map((g) => GROUP_TO_ROLE[g]).filter((r): r is UserRole => Boolean(r))),
  ];

  if (roles.length === 0) {
    throw new ValidationError(
      'Cannot derive role: caller is not a member of exactly one base-role Cognito group ' +
        '(PrimaryUser, SupportPerson, or OrganizationAdmin)',
    );
  }
  if (roles.length > 1) {
    throw new ValidationError(
      `Cannot derive role: caller belongs to multiple base-role groups (${roles.join(', ')}); ` +
        'base roles are mutually exclusive',
    );
  }
  return roles[0];
}
