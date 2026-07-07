import {
  assertCanActForUser,
  assertCanReadTask,
  assertCanReadTaskById,
  canActForUser,
  hasActiveAssignmentForTask,
} from './delegation';
import { dynamo } from './dynamodb';

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

describe('assertCanActForUser — delegated (SupportPerson)', () => {
  const sameOrg = () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      [PU]: { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-1' },
    };
  };

  it('allows a SupportPerson with an ACTIVE link in the same org', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).resolves.toBe(SP);
  });

  it('rejects a non-SupportPerson caller acting on another user', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
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

  it('rejects when the link is REVOKED', async () => {
    sameOrg();
    db.links = { [`${SP}->${PU}`]: { status: 'REVOKED' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no active support link/,
    );
  });

  it('rejects when the primary user moved orgs after the link (stale link does not grant access)', async () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      // Primary user is now in a DIFFERENT org than the supporter.
      [PU]: { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-2' },
    };
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no longer in the same organization/,
    );
  });

  it('rejects when the supporter has no organization', async () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON' },
      [PU]: { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-1' },
    };
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /same organization/,
    );
  });

  it('rejects an ACTIVE link whose target is a SUPPORT_PERSON (only primary users may be acted on)', async () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      // A legacy/stale ACTIVE link pointing at another SupportPerson must not grant access.
      [PU]: { userId: PU, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
    };
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /only permitted for a primary user/,
    );
  });

  it('rejects an ACTIVE link whose target is an ORG_ADMIN', async () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      [PU]: { userId: PU, role: 'ORG_ADMIN', organizationId: 'org-1' },
    };
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /only permitted for a primary user/,
    );
  });

  it('rejects when the target profile is missing (deleted user)', async () => {
    db.profiles = { [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' } };
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(assertCanActForUser(identity(SP, ['SupportPerson']), PU)).rejects.toThrow(
      /no longer has a profile/,
    );
  });
});

describe('canActForUser (non-throwing)', () => {
  it('is true for self', async () => {
    await expect(canActForUser(identity('me'), 'me')).resolves.toBe(true);
  });

  it('is true for a SupportPerson with an ACTIVE link in the same org', async () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      [PU]: { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-1' },
    };
    db.links = { [`${SP}->${PU}`]: { status: 'ACTIVE' } };
    await expect(canActForUser(identity(SP, ['SupportPerson']), PU)).resolves.toBe(true);
  });

  it('is false (not thrown) when delegation is denied', async () => {
    await expect(canActForUser(identity('intruder'), PU)).resolves.toBe(false);
  });
});

describe('assertCanReadTask', () => {
  it('allows the owner without an assignment query', async () => {
    await expect(assertCanReadTask(identity('owner-1'), { taskId: 't1', ownerId: 'owner-1' })).resolves.toBe(
      'owner-1',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('allows a delegated SupportPerson (active link to the owner) to read', async () => {
    db.profiles = {
      [SP]: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      ['owner-1']: { userId: 'owner-1', role: 'PRIMARY_USER', organizationId: 'org-1' },
    };
    db.links = { [`${SP}->owner-1`]: { status: 'ACTIVE' } };
    await expect(
      assertCanReadTask(identity(SP, ['SupportPerson']), { taskId: 't1', ownerId: 'owner-1' }),
    ).resolves.toBe(SP);
  });

  it('allows a non-owner who holds an active assignment referencing the task', async () => {
    db.activeAssignments = [{ PK: 'USER#primary-1', taskId: 't1', active: true }];
    await expect(assertCanReadTask(identity(PU), { taskId: 't1', ownerId: 'owner-1' })).resolves.toBe(PU);
  });

  it('rejects a non-owner who cannot act for the owner and has no assignment', async () => {
    await expect(assertCanReadTask(identity(PU), { taskId: 't1', ownerId: 'owner-1' })).rejects.toThrow(
      /does not own this task/,
    );
  });
});

describe('assertCanReadTaskById', () => {
  it('404s when the task does not exist', async () => {
    await expect(assertCanReadTaskById(identity('owner-1'), 'gone')).rejects.toThrow('task gone not found');
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
