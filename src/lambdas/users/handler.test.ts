import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

function event(fieldName: string, args: Record<string, unknown>) {
  return { arguments: args, info: { fieldName } } as Parameters<typeof handler>[0];
}

const lastInput = () => mockSend.mock.calls[0][0].input;

describe('users handler — UserProfile', () => {
  it('createUserProfile writes USER#<id>/#PROFILE carrying the orgIndex fields (organizationId, userId)', async () => {
    await handler(
      event('createUserProfile', {
        input: { userId: 'u1', role: 'PRIMARY_USER', displayName: 'Sam', organizationId: 'org-1' },
      }),
    );
    const { Item } = lastInput();
    expect(Item.PK).toBe('USER#u1');
    expect(Item.SK).toBe('#PROFILE');
    expect(Item.entityType).toBe('UserProfile');
    expect(Item.userId).toBe('u1');
    expect(Item.organizationId).toBe('org-1');
    expect(Item.role).toBe('PRIMARY_USER');
    expect(typeof Item.createdAt).toBe('string');
  });

  it('createUserProfile requires userId and role', async () => {
    await expect(handler(event('createUserProfile', { input: { role: 'PRIMARY_USER' } }))).rejects.toThrow(
      'userId is required',
    );
    await expect(handler(event('createUserProfile', { input: { userId: 'u1' } }))).rejects.toThrow(
      'role is required',
    );
  });

  it('getUserProfile reads PK=USER#<id>, SK=#PROFILE and returns null when absent', async () => {
    mockSend.mockResolvedValueOnce({}); // no Item
    const result = await handler(event('getUserProfile', { userId: 'u1' }));
    expect(lastInput().Key).toEqual({ PK: 'USER#u1', SK: '#PROFILE' });
    expect(result).toBeNull();
  });

  it('listUsersByOrganization queries the orgIndex by organizationId', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ userId: 'u1', role: 'PRIMARY_USER' }] });
    const result = await handler(event('listUsersByOrganization', { organizationId: 'org-1' }));
    expect(lastInput().IndexName).toBe('orgIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':org': 'org-1' });
    expect(result).toHaveLength(1);
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
    const result = await handler(event('listPrimaryUsersBySupporter', { supporterId: 's1' }));
    expect(lastInput().IndexName).toBe('supporterIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':sup': 's1' });
    expect(result).toHaveLength(1);
  });
});

describe('users handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
