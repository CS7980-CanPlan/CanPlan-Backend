import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { decodeNextToken, encodeNextToken } from '../../shared/pagination';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => mockSend.mockResolvedValue({ Items: [] }));
afterEach(() => jest.clearAllMocks());

function event(fieldName: string, args: Record<string, unknown>, groups: string[] | null = ['SystemAdmin']) {
  return { arguments: args, info: { fieldName }, identity: { groups } } as Parameters<typeof handler>[0];
}

const lastCommand = () => mockSend.mock.calls[0][0];
const lastInput = () => lastCommand().input;

describe('admin handler — SystemAdmin authorization', () => {
  it('listAllUsers rejects a caller who is not in the SystemAdmin group', async () => {
    await expect(handler(event('listAllUsers', {}, ['SupportPerson']))).rejects.toThrow(
      'Unauthorized: SystemAdmin access required',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('listAllTasks rejects a caller with no groups', async () => {
    await expect(handler(event('listAllTasks', {}, null))).rejects.toThrow('SystemAdmin');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('accepts groups supplied via the raw cognito:groups claim', async () => {
    const evt = {
      arguments: {},
      info: { fieldName: 'listAllUsers' },
      identity: { claims: { 'cognito:groups': ['SystemAdmin'] } },
    } as Parameters<typeof handler>[0];
    await expect(handler(evt)).resolves.toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('admin handler — entityTypeIndex queries (no Scan)', () => {
  it('listAllUsers queries entityTypeIndex for entityType=UserProfile, newest-first', async () => {
    await handler(event('listAllUsers', {}));
    expect(lastCommand().constructor.name).toBe('QueryCommand'); // never a ScanCommand
    expect(lastInput().IndexName).toBe('entityTypeIndex');
    expect(lastInput().KeyConditionExpression).toBe('entityType = :et');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':et': 'UserProfile' });
    expect(lastInput().ScanIndexForward).toBe(false);
  });

  it('listAllTasks queries entityTypeIndex for entityType=Task', async () => {
    await handler(event('listAllTasks', {}));
    expect(lastCommand().constructor.name).toBe('QueryCommand');
    expect(lastInput().IndexName).toBe('entityTypeIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':et': 'Task' });
  });

  it('throws on an unsupported field', async () => {
    await expect(handler(event('listAllAardvarks', {}))).rejects.toThrow('unsupported field');
  });
});

describe('admin handler — pagination', () => {
  it('passes a positive limit through and omits it otherwise', async () => {
    await handler(event('listAllUsers', { limit: 25 }));
    expect(lastInput().Limit).toBe(25);

    mockSend.mockClear();
    await handler(event('listAllUsers', {}));
    expect(lastInput().Limit).toBeUndefined();
  });

  it('decodes an incoming nextToken into ExclusiveStartKey', async () => {
    const key = { entityType: 'UserProfile', createdAt: '2026-06-15T10:00:00Z', PK: 'USER#u1', SK: '#PROFILE' };
    await handler(event('listAllUsers', { nextToken: encodeNextToken(key)! }));
    expect(lastInput().ExclusiveStartKey).toEqual(key);
  });

  it('returns an encoded nextToken when DynamoDB reports a LastEvaluatedKey', async () => {
    const lek = { entityType: 'Task', createdAt: '2026-06-15T09:00:00Z', PK: 'TASK#t1', SK: '#META' };
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 't1' }], LastEvaluatedKey: lek });
    const result = await handler(event('listAllTasks', { limit: 1 }));
    expect(result.items).toHaveLength(1);
    expect(result.nextToken).not.toBeNull();
    expect(decodeNextToken(result.nextToken)).toEqual(lek);
  });

  it('returns a null nextToken on the last page', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ userId: 'u1' }] }); // no LastEvaluatedKey
    const result = await handler(event('listAllUsers', {}));
    expect(result.nextToken).toBeNull();
  });
});
