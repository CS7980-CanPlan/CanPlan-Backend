import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { encodeNextToken } from '../../shared/pagination';
import type { Connection } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

function event(
  fieldName: string,
  args: Record<string, unknown>,
  identity?: { sub?: string; groups?: string[] | null; claims?: Record<string, unknown> },
) {
  return { arguments: args, info: { fieldName }, identity } as Parameters<typeof handler>[0];
}

// A signed-in caller: Cognito sub + group membership + email claim.
const caller = (groups: string[], sub = 'cognito-sub-1', email = 'me@example.com') => ({
  sub,
  groups,
  claims: { email },
});

const lastInput = () => mockSend.mock.calls[0][0].input;

describe('users handler — UserProfile', () => {
  it('createUserProfile derives userId from the Cognito sub, role from group, email from the claim', async () => {
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-123', 'sam@example.com'),
      ),
    );
    const { Item } = lastInput();
    expect(Item.PK).toBe('USER#sub-123');
    expect(Item.SK).toBe('#PROFILE');
    expect(Item.entityType).toBe('UserProfile');
    // userId comes from the Cognito sub, never the input.
    expect(Item.userId).toBe('sub-123');
    expect(Item.role).toBe('PRIMARY_USER');
    expect(Item.email).toBe('sam@example.com');
    expect(Item.displayName).toBe('Sam');
    expect(Item.organizationId).toBe('org-1');
    expect(typeof Item.createdAt).toBe('string');
  });

  it('createUserProfile maps SupportPerson → SUPPORT_PERSON and OrganizationAdmin → ORG_ADMIN', async () => {
    await handler(event('createUserProfile', { input: { displayName: 'Supporter' } }, caller(['SupportPerson'])));
    expect(lastInput().Item.role).toBe('SUPPORT_PERSON');

    await handler(
      event('createUserProfile', { input: { displayName: 'Organization admin' } }, caller(['OrganizationAdmin'])),
    );
    expect(mockSend.mock.calls[1][0].input.Item.role).toBe('ORG_ADMIN');
  });

  it('createUserProfile requires a non-empty displayName', async () => {
    await expect(
      handler(event('createUserProfile', { input: { displayName: '   ' } }, caller(['PrimaryUser']))),
    ).rejects.toThrow('displayName is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile ignores any client-supplied id/email/role — only identity is trusted', async () => {
    await handler(
      event(
        'createUserProfile',
        // Attacker tries to inject another user's id/email/role; these fields are not
        // part of the input type and must be ignored entirely.
        {
          input: {
            displayName: 'My profile',
            userId: 'victim',
            email: 'victim@evil.com',
            role: 'ORG_ADMIN',
          } as Record<string, unknown>,
        },
        caller(['PrimaryUser'], 'sub-me', 'me@example.com'),
      ),
    );
    const { Item } = lastInput();
    expect(Item.userId).toBe('sub-me'); // not 'victim'
    expect(Item.email).toBe('me@example.com'); // not 'victim@evil.com'
    expect(Item.role).toBe('PRIMARY_USER'); // not the injected ORG_ADMIN
  });

  it('createUserProfile rejects an unauthenticated caller (no sub)', async () => {
    await expect(handler(event('createUserProfile', { input: {} }, undefined))).rejects.toThrow(
      'authenticated user is required',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile rejects a caller with no base-role group', async () => {
    await expect(
      handler(event('createUserProfile', { input: {} }, caller(['SystemAdmin']))),
    ).rejects.toThrow(/exactly one base-role/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile rejects a caller with multiple base-role groups', async () => {
    await expect(
      handler(event('createUserProfile', { input: {} }, caller(['PrimaryUser', 'OrganizationAdmin']))),
    ).rejects.toThrow(/multiple base-role/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('getUserProfile reads PK=USER#<id>, SK=#PROFILE and returns null when absent', async () => {
    mockSend.mockResolvedValueOnce({}); // no Item
    const result = await handler(event('getUserProfile', { userId: 'u1' }));
    expect(lastInput().Key).toEqual({ PK: 'USER#u1', SK: '#PROFILE' });
    expect(result).toBeNull();
  });

  it('listUsersByOrganization queries the orgIndex by organizationId and returns a connection', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ userId: 'u1', role: 'PRIMARY_USER' }] });
    const result = (await handler(
      event('listUsersByOrganization', { organizationId: 'org-1' }),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('orgIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':org': 'org-1' });
    expect(result.items).toHaveLength(1);
    expect(result.nextToken).toBeNull();
  });

  it('listUsersByOrganization forwards limit and decodes nextToken into ExclusiveStartKey', async () => {
    const startKey = { organizationId: 'org-1', userId: 'u0', PK: 'USER#u0', SK: '#PROFILE' };
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: startKey });
    const result = (await handler(
      event('listUsersByOrganization', {
        organizationId: 'org-1',
        limit: 10,
        nextToken: encodeNextToken(startKey)!,
      }),
    )) as Connection<unknown>;
    expect(lastInput().Limit).toBe(10);
    expect(lastInput().ExclusiveStartKey).toEqual(startKey);
    expect(result.nextToken).not.toBeNull(); // LastEvaluatedKey present → another page
  });
});

describe('users handler — SupportLink', () => {
  it('createSupportLink writes SUPPORTER#<id>/USER#<id> carrying the supporterIndex fields (supporterId, userId)', async () => {
    await handler(
      event('createSupportLink', { input: { supporterId: 's1', primaryUserId: 'u1', status: 'ACTIVE' } }),
    );
    const { Item } = lastInput();
    expect(Item.PK).toBe('SUPPORTER#s1');
    expect(Item.SK).toBe('USER#u1');
    expect(Item.entityType).toBe('SupportLink');
    expect(Item.supporterId).toBe('s1');
    expect(Item.primaryUserId).toBe('u1');
    // userId mirrors primaryUserId so it can be the supporterIndex sort key.
    expect(Item.userId).toBe('u1');
    expect(Item.status).toBe('ACTIVE');
  });

  it('createSupportLink defaults status to PENDING and validates ids', async () => {
    await handler(event('createSupportLink', { input: { supporterId: 's1', primaryUserId: 'u1' } }));
    expect(lastInput().Item.status).toBe('PENDING');
    await expect(handler(event('createSupportLink', { input: { supporterId: 's1' } }))).rejects.toThrow(
      'primaryUserId is required',
    );
  });

  it('listPrimaryUsersBySupporter queries the supporterIndex by supporterId', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ supporterId: 's1', userId: 'u1' }] });
    const result = (await handler(
      event('listPrimaryUsersBySupporter', { supporterId: 's1' }),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('supporterIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':sup': 's1' });
    expect(result.items).toHaveLength(1);
  });
});

describe('users handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
