import {
  assertCanActForUser,
  assertCanReadTask,
  assertCanReadTaskById,
  canActForUser,
  hasActiveAssignmentForTask,
  supportLinkIneffectiveReason,
} from './delegation';
import { dynamo } from './dynamodb';
import type { SupportLink, UserProfile } from './types';

jest.mock('./dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));

const mockSend = dynamo.send as jest.Mock;

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose mock helpers

/**
 * Mock DynamoDB by command type + key. Tests populate `db` to control what each read returns:
 *  - profiles: by userId (#PROFILE GET)
 *  - links: by `${supporterId}->${primaryUserId}` (SUPPORTER#/USER# GET)
 *  - taskMeta: by taskId (#META GET)
 *  - activeAssignments: rows returned by the active-assignment Query (each carries PK + taskId + active)
 */
interface DbState {
  profiles?: Record<string, Rec | undefined>;
  links?: Record<string, Rec | undefined>;
  taskMeta?: Record<string, Rec | undefined>;
  activeAssignments?: Rec[];
}
let db: DbState = {};

beforeEach(() => {
  db = {};
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'GetCommand') {
      const pk: string = input.Key.PK;
      const sk: string = input.Key.SK;
      if (sk === '#PROFILE') {
        return Promise.resolve({ Item: db.profiles?.[pk.replace(/^USER#/, '')] });
      }
      if (sk === '#META') {
        return Promise.resolve({ Item: db.taskMeta?.[pk.replace(/^TASK#/, '')] });
      }
      if (sk.startsWith('USER#')) {
        const supporterId = pk.replace(/^SUPPORTER#/, '');
        const primaryUserId = sk.replace(/^USER#/, '');
        return Promise.resolve({ Item: db.links?.[`${supporterId}->${primaryUserId}`] });
      }
      return Promise.resolve({});
    }
    if (name === 'QueryCommand') {
      const values: Rec = input.ExpressionAttributeValues ?? {};
      const items = (db.activeAssignments ?? []).filter(
        (a) => a.PK === values[':pk'] && a.taskId === values[':taskId'] && a.active === true,
      );
      return Promise.resolve({ Items: items });
    }
    return Promise.resolve({});
  });
});
afterEach(() => jest.clearAllMocks());

const identity = (sub: string | undefined, groups: string[] = []) =>
  (sub ? { sub, groups } : undefined) as Parameters<typeof assertCanActForUser>[0];

const SP = 'support-1';
const PU = 'primary-1';

describe('hasActiveAssignmentForTask', () => {
  it('is true when the user holds an active assignment referencing the task', async () => {
    db.activeAssignments = [{ PK: 'USER#primary-1', taskId: 't1', active: true }];
    await expect(hasActiveAssignmentForTask(PU, 't1')).resolves.toBe(true);
  });

  it('is false when no active assignment references the task (inactive or different task)', async () => {
    db.activeAssignments = [
      { PK: 'USER#primary-1', taskId: 't1', active: false },
      { PK: 'USER#primary-1', taskId: 't2', active: true },
    ];
    await expect(hasActiveAssignmentForTask(PU, 't1')).resolves.toBe(false);
  });
});

describe('assertCanActForUser — self', () => {
  it('allows a user to act on their own schedule without any reads', async () => {
    await expect(assertCanActForUser(identity(PU), PU)).resolves.toBe(PU);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(assertCanActForUser(identity(undefined), PU)).rejects.toThrow(
      'authenticated user is required',
    );
  });
});

// Profiles carrying current organization membership SESSIONS, and a link whose selection
// snapshot matches them — the only combination that grants delegated access.
const sameOrg = () => {
  db.profiles = {
    [SP]: {
      userId: SP,
      role: 'SUPPORT_PERSON',
      organizationId: 'org-1',
      organizationMembershipId: 'mid-sp',
    },
    [PU]: {
      userId: PU,
      role: 'PRIMARY_USER',
      organizationId: 'org-1',
      organizationMembershipId: 'mid-pu',
    },
  };
};
const effectiveLink = (overrides: Rec = {}): Rec => ({
  status: 'ACTIVE',
  organizationId: 'org-1',
  supporterOrganizationMembershipId: 'mid-sp',
  primaryUserOrganizationMembershipId: 'mid-pu',
  ...overrides,
});

describe('assertCanActForUser — delegated (SupportPerson)', () => {
  it("allows a SupportPerson whose ACTIVE link matches both parties' current membership snapshot", async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).resolves.toBe(SP);
    // Link + both profiles are authorization state and must observe a just-committed revoke or
    // membership change rather than authorizing from an eventually-consistent replica.
    const gets = mockSend.mock.calls
      .map((call) => call[0])
      .filter((command) => command.constructor.name === 'GetCommand');
    expect(gets).toHaveLength(3);
    expect(gets.every((command) => command.input.ConsistentRead === true)).toBe(true);
  });

  it('rejects a non-SupportPerson caller acting on another user', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['PrimaryUser']), PU)).rejects.toThrow(
      /not allowed to act on this user/,
    );
  });

  it('rejects when there is no support link', async () => {
    sameOrg();
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no active support link/,
    );
  });

  it('rejects when the link is REVOKED (e.g. after an organization change)', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: effectiveLink({ status: 'REVOKED' }) };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no active support link/,
    );
  });

  it('rejects when the primary user moved orgs after the link (stale link does not grant access)', async () => {
    sameOrg();
    // Primary user is now in a DIFFERENT org than the supporter.
    db.profiles![PU] = {
      ...db.profiles![PU],
      organizationId: 'org-2',
      organizationMembershipId: 'mid-pu-2',
    };
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no longer in the same organization/,
    );
  });

  it('rejects when the supporter has no organization', async () => {
    sameOrg();
    db.profiles![SP] = { userId: SP, role: 'SUPPORT_PERSON' };
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /same organization/,
    );
  });

  it('rejects an ACTIVE link whose target is a SUPPORT_PERSON (only primary users may be acted on)', async () => {
    sameOrg();
    // A legacy/stale ACTIVE link pointing at another SupportPerson must not grant access.
    db.profiles![PU] = { ...db.profiles![PU], role: 'SUPPORT_PERSON' };
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /only permitted for a primary user/,
    );
  });

  it('rejects an ACTIVE link whose target is an ORG_ADMIN', async () => {
    sameOrg();
    db.profiles![PU] = { ...db.profiles![PU], role: 'ORG_ADMIN' };
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /only permitted for a primary user/,
    );
  });

  it('rejects when the target profile is missing (deleted user)', async () => {
    db.profiles = {
      [SP]: {
        userId: SP,
        role: 'SUPPORT_PERSON',
        organizationId: 'org-1',
        organizationMembershipId: 'mid-sp',
      },
    };
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no longer has a profile/,
    );
  });

  it('rejects a LEGACY ACTIVE link with no membership snapshot (fails closed; ACTIVE alone is insufficient)', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /stale.*select the user again/,
    );
  });

  it("rejects a link whose stored organizationId differs from the parties' current org", async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: effectiveLink({ organizationId: 'org-0' }) };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(/stale/);
  });

  it('rejects a link selected under an OLDER supporter membership session (mismatched membership id)', async () => {
    sameOrg();
    db.links = {
      [`${SP}->${PU}`]: effectiveLink({ supporterOrganizationMembershipId: 'mid-sp-old' }),
    };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(/stale/);
  });

  it('rejects a link selected under an OLDER primary-user membership session — e.g. after leave + rejoin of the SAME org', async () => {
    sameOrg();
    // The primary user left org-1 and rejoined it: same organizationId, NEW membership id.
    db.profiles![PU] = { ...db.profiles![PU], organizationMembershipId: 'mid-pu-rejoined' };
    db.links = { [`${SP}->${PU}`]: effectiveLink() }; // snapshot still holds the old mid-pu
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(/stale/);
  });

  it('rejects when a profile has no membership id yet (legacy, never re-selected) even if the link carries one', async () => {
    sameOrg();
    delete db.profiles![PU]!.organizationMembershipId;
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(/stale/);
  });
});

describe('supportLinkIneffectiveReason (shared effective-link predicate)', () => {
  const profiles = () => ({
    supporter: {
      userId: SP,
      role: 'SUPPORT_PERSON',
      organizationId: 'org-1',
      organizationMembershipId: 'mid-sp',
    } as UserProfile,
    target: {
      userId: PU,
      role: 'PRIMARY_USER',
      organizationId: 'org-1',
      organizationMembershipId: 'mid-pu',
    } as UserProfile,
  });

  it('is null (effective) only for a full, matching snapshot', () => {
    const { supporter, target } = profiles();
    expect(
      supportLinkIneffectiveReason(effectiveLink() as unknown as SupportLink, supporter, target),
    ).toBeNull();
  });

  it('fails closed when BOTH the link snapshot and the profile membership ids are missing (legacy ≠ match)', () => {
    const { supporter, target } = profiles();
    delete supporter.organizationMembershipId;
    delete target.organizationMembershipId;
    expect(
      supportLinkIneffectiveReason({ status: 'ACTIVE' } as SupportLink, supporter, target),
    ).toMatch(/stale/);
  });

  it('reports a missing supporter profile', () => {
    const { target } = profiles();
    expect(
      supportLinkIneffectiveReason(effectiveLink() as unknown as SupportLink, undefined, target),
    ).toMatch(/support person no longer has a profile/);
  });
});

describe('canActForUser (non-throwing)', () => {
  it('is true for self', async () => {
    await expect(canActForUser(identity('me'), 'me')).resolves.toBe(true);
  });

  it('is true for a SupportPerson with an effective (snapshot-matching) ACTIVE link', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: effectiveLink() };
    await expect(canActForUser(identity(SP, ['SupportPerson']), PU)).resolves.toBe(true);
  });

  it('is false (not thrown) when delegation is denied', async () => {
    await expect(canActForUser(identity('intruder'), PU)).resolves.toBe(false);
  });

  it('is false for a legacy ACTIVE link without a membership snapshot', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(canActForUser(identity(SP, ['SupportPerson']), PU)).resolves.toBe(false);
  });
});

describe('assertCanReadTask', () => {
  it('allows the owner without an assignment query', async () => {
    await expect(
      assertCanReadTask(identity('owner-1'), { taskId: 't1', ownerId: 'owner-1' }),
    ).resolves.toBe('owner-1');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('allows a delegated SupportPerson (effective link to the owner) to read', async () => {
    db.profiles = {
      [SP]: {
        userId: SP,
        role: 'SUPPORT_PERSON',
        organizationId: 'org-1',
        organizationMembershipId: 'mid-sp',
      },
      ['owner-1']: {
        userId: 'owner-1',
        role: 'PRIMARY_USER',
        organizationId: 'org-1',
        organizationMembershipId: 'mid-pu',
      },
    };
    db.links = { [`${SP}->owner-1`]: effectiveLink() };
    await expect(
      assertCanReadTask(identity(SP, ['SupportPerson']), { taskId: 't1', ownerId: 'owner-1' }),
    ).resolves.toBe(SP);
  });

  it('allows a non-owner who holds an active assignment referencing the task', async () => {
    db.activeAssignments = [{ PK: 'USER#primary-1', taskId: 't1', active: true }];
    await expect(
      assertCanReadTask(identity(PU), { taskId: 't1', ownerId: 'owner-1' }),
    ).resolves.toBe(PU);
  });

  it('rejects a non-owner who cannot act for the owner and has no assignment', async () => {
    await expect(
      assertCanReadTask(identity(PU), { taskId: 't1', ownerId: 'owner-1' }),
    ).rejects.toThrow(/does not own this task/);
  });
});

describe('assertCanReadTaskById', () => {
  it('404s when the task does not exist', async () => {
    await expect(assertCanReadTaskById(identity('owner-1'), 'gone')).rejects.toThrow(
      'task gone not found',
    );
  });

  it('returns the caller + task for the owner', async () => {
    db.taskMeta = { t1: { taskId: 't1', ownerId: 'owner-1' } };
    const result = await assertCanReadTaskById(identity('owner-1'), 't1');
    expect(result.caller).toBe('owner-1');
    expect(result.task.taskId).toBe('t1');
  });

  it('allows an assigned primary user to read by id', async () => {
    db.taskMeta = { t1: { taskId: 't1', ownerId: 'owner-1' } };
    db.activeAssignments = [{ PK: 'USER#primary-1', taskId: 't1', active: true }];
    const result = await assertCanReadTaskById(identity(PU), 't1');
    expect(result.caller).toBe(PU);
  });
});
