import { assertCanAccessUserReports } from './reportAuthz';
import { dynamo } from './dynamodb';
import { UnauthorizedError, ValidationError } from './response';
import type { AppSyncIdentity } from './types';

jest.mock('./dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));

const mockSend = dynamo.send as jest.Mock;

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose mock helpers

/**
 * Mock DynamoDB by command + key so the REAL delegation rules (SupportPerson group, ACTIVE link,
 * PRIMARY_USER target, shared org, matching membership snapshot) run against controlled data:
 *  - profiles: by userId (#PROFILE GET)
 *  - links: by `${supporterId}->${primaryUserId}` (SUPPORTER#/USER# GET)
 */
interface DbState {
  profiles?: Record<string, Rec | undefined>;
  links?: Record<string, Rec | undefined>;
}
let db: DbState = {};

beforeEach(() => {
  db = {};
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
    const { input } = command;
    if (command.constructor.name === 'GetCommand') {
      const pk: string = input.Key.PK;
      const sk: string = input.Key.SK;
      if (sk === '#PROFILE') {
        return Promise.resolve({ Item: db.profiles?.[pk.replace(/^USER#/, '')] });
      }
      if (sk.startsWith('USER#')) {
        const supporterId = pk.replace(/^SUPPORTER#/, '');
        const primaryUserId = sk.replace(/^USER#/, '');
        return Promise.resolve({ Item: db.links?.[`${supporterId}->${primaryUserId}`] });
      }
    }
    return Promise.resolve({});
  });
});
afterEach(() => jest.clearAllMocks());

/** A SupportPerson caller identity (Cognito group is the authorization source of truth). */
const supporter: AppSyncIdentity = { sub: 'sup-1', groups: ['SupportPerson'] };

/**
 * Wire up the happy-path world: an ACTIVE link between a same-org SupportPerson and PrimaryUser
 * whose selection snapshot (organization + both membership sessions) still matches both profiles
 * — the only combination that grants delegated access.
 */
function grantHappyPath(): void {
  db.profiles = {
    'sup-1': {
      userId: 'sup-1',
      role: 'SUPPORT_PERSON',
      organizationId: 'org-1',
      organizationMembershipId: 'mid-sup',
    },
    'pu-1': {
      userId: 'pu-1',
      role: 'PRIMARY_USER',
      organizationId: 'org-1',
      organizationMembershipId: 'mid-pu',
    },
  };
  db.links = {
    'sup-1->pu-1': {
      status: 'ACTIVE',
      organizationId: 'org-1',
      supporterOrganizationMembershipId: 'mid-sup',
      primaryUserOrganizationMembershipId: 'mid-pu',
    },
  };
}

describe('assertCanAccessUserReports', () => {
  it('allows a SupportPerson whose ACTIVE link matches both users current membership snapshot', async () => {
    grantHappyPath();
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).resolves.toBe('sup-1');
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(assertCanAccessUserReports(undefined, 'pu-1')).rejects.toThrow(UnauthorizedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an empty target userId', async () => {
    await expect(assertCanAccessUserReports(supporter, '   ')).rejects.toThrow(ValidationError);
  });

  it('rejects a primary user accessing their OWN reports (self-access denied, no reads)', async () => {
    const selfUser: AppSyncIdentity = { sub: 'pu-1', groups: ['PrimaryUser'] };
    await expect(assertCanAccessUserReports(selfUser, 'pu-1')).rejects.toThrow(UnauthorizedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a non-SupportPerson caller', async () => {
    grantHappyPath();
    const notSupport: AppSyncIdentity = { sub: 'sup-1', groups: ['PrimaryUser'] };
    await expect(assertCanAccessUserReports(notSupport, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a SupportPerson without an ACTIVE link (revoked)', async () => {
    grantHappyPath();
    db.links = { 'sup-1->pu-1': { status: 'REVOKED' } };
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a SupportPerson with no link at all', async () => {
    grantHappyPath();
    db.links = {};
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects when the target is not a PRIMARY_USER', async () => {
    grantHappyPath();
    db.profiles!['pu-1'] = { userId: 'pu-1', role: 'SUPPORT_PERSON', organizationId: 'org-1' };
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects when the target profile no longer exists', async () => {
    grantHappyPath();
    delete db.profiles!['pu-1'];
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects an organization mismatch between supporter and target', async () => {
    grantHappyPath();
    db.profiles!['pu-1'] = { userId: 'pu-1', role: 'PRIMARY_USER', organizationId: 'org-2' };
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a legacy ACTIVE link without a membership snapshot (fails closed until re-selected)', async () => {
    grantHappyPath();
    db.links = { 'sup-1->pu-1': { status: 'ACTIVE' } };
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a link selected under an older membership session (e.g. the target left and rejoined the org)', async () => {
    grantHappyPath();
    db.profiles!['pu-1'] = {
      ...db.profiles!['pu-1'],
      organizationMembershipId: 'mid-pu-rejoined',
    };
    await expect(assertCanAccessUserReports(supporter, 'pu-1')).rejects.toThrow(UnauthorizedError);
  });
});
