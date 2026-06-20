import { roleFromIdentity } from './roles';
import type { AppSyncIdentity } from './types';

const identity = (groups: string[] | null, claims?: Record<string, unknown>): AppSyncIdentity => ({
  sub: 'u1',
  groups,
  claims,
});

describe('roleFromIdentity — Cognito group → UserRole', () => {
  it('maps PrimaryUser → PRIMARY_USER', () => {
    expect(roleFromIdentity(identity(['PrimaryUser']))).toBe('PRIMARY_USER');
  });

  it('maps SupportPerson → SUPPORT_PERSON', () => {
    expect(roleFromIdentity(identity(['SupportPerson']))).toBe('SUPPORT_PERSON');
  });

  it('maps OrganizationAdmin → ORG_ADMIN', () => {
    expect(roleFromIdentity(identity(['OrganizationAdmin']))).toBe('ORG_ADMIN');
  });

  it('ignores non-base groups: SystemAdmin alongside a base role still resolves the base role', () => {
    expect(roleFromIdentity(identity(['SystemAdmin', 'PrimaryUser']))).toBe('PRIMARY_USER');
  });

  it('rejects SystemAdmin alone — it is not a business UserRole', () => {
    expect(() => roleFromIdentity(identity(['SystemAdmin']))).toThrow(/exactly one base-role/);
  });

  it('rejects zero base-role groups', () => {
    expect(() => roleFromIdentity(identity([]))).toThrow(/exactly one base-role/);
    expect(() => roleFromIdentity(identity(null))).toThrow(/exactly one base-role/);
    expect(() => roleFromIdentity(undefined)).toThrow(/exactly one base-role/);
  });

  it('rejects multiple base-role groups (mutually exclusive)', () => {
    expect(() => roleFromIdentity(identity(['PrimaryUser', 'SupportPerson']))).toThrow(
      /multiple base-role/,
    );
  });

  it('reads groups from the cognito:groups claim when identity.groups is absent', () => {
    expect(roleFromIdentity(identity(null, { 'cognito:groups': ['OrganizationAdmin'] }))).toBe(
      'ORG_ADMIN',
    );
  });
});
