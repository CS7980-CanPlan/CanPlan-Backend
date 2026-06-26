import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AdminBaseRole } from './types';

// Single shared Cognito Identity Provider client reused across Lambda invocations.
// The user pool lives in the backend region (same as the Lambda's AWS_REGION).
export const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? 'ca-central-1',
});

// User Pool the admin Lambda manages users in. Injected by the Functions construct;
// empty in unit tests (the Cognito client is mocked there).
export const USER_POOL_ID = process.env.USER_POOL_ID ?? '';

// ── Cognito group names (the source of truth for authorization) ──────────────────
// The base business roles are MUTUALLY EXCLUSIVE; SystemAdmin is an elevated group that
// may coexist with one base role (see src/shared/roles.ts). Group names mirror the
// ROLE_GROUPS seeded in infrastructure/lib/constructs/auth.construct.ts.
export const PRIMARY_USER_GROUP = process.env.PRIMARY_USER_GROUP ?? 'PrimaryUser';
export const SUPPORT_PERSON_GROUP = 'SupportPerson';
export const ORGANIZATION_ADMIN_GROUP = 'OrganizationAdmin';
export const SYSTEM_ADMIN_GROUP = 'SystemAdmin';

/** The three mutually-exclusive base-role groups (SystemAdmin is intentionally excluded). */
export const BASE_ROLE_GROUPS = [
  PRIMARY_USER_GROUP,
  SUPPORT_PERSON_GROUP,
  ORGANIZATION_ADMIN_GROUP,
] as const;

/**
 * Map the AdminBaseRole GraphQL enum onto its Cognito group. The enum values are also the
 * UserRole projection values (PRIMARY_USER/SUPPORT_PERSON/ORG_ADMIN), so no second mapping
 * is needed to update UserProfile.role.
 */
export const BASE_ROLE_TO_GROUP: Readonly<Record<AdminBaseRole, string>> = {
  PRIMARY_USER: PRIMARY_USER_GROUP,
  SUPPORT_PERSON: SUPPORT_PERSON_GROUP,
  ORG_ADMIN: ORGANIZATION_ADMIN_GROUP,
};

/**
 * Resolve the Cognito Username for an app-level userId (the Cognito `sub`). Admin APIs
 * are keyed by `sub`, but Cognito's Admin* commands require the Username — which is NOT the
 * sub for an email-alias pool. ListUsers with a `sub = "…"` filter bridges the two. Returns
 * undefined when no user has that sub (already deleted, or never existed).
 */
export async function findCognitoUsernameBySub(
  userPoolId: string,
  sub: string,
): Promise<string | undefined> {
  const result = await cognito.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${sub}"`, Limit: 1 }),
  );
  return result.Users?.[0]?.Username;
}

/** The Cognito group names a user currently belongs to (empty when none). */
export async function listGroupsForUser(
  userPoolId: string,
  username: string,
): Promise<string[]> {
  const result = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username }),
  );
  return (result.Groups ?? [])
    .map((group) => group.GroupName)
    .filter((name): name is string => Boolean(name));
}
