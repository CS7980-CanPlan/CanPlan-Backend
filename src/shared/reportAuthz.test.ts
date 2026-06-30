import { assertCanAccessUserReports } from './reportAuthz';
import { dynamo } from './dynamodb';

jest.mock('./dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'T' }));
const mockSend = dynamo.send as jest.Mock;

afterEach(() => jest.clearAllMocks());

describe('assertCanAccessUserReports', () => {
  it('resolves when an ACTIVE support link exists', async () => {
    mockSend.mockResolvedValue({ Item: { status: 'ACTIVE' } });
    await expect(assertCanAccessUserReports('sup-1', 'user-1')).resolves.toBeUndefined();
    // Looks up PK=SUPPORTER#sup-1, SK=USER#user-1
    const key = mockSend.mock.calls[0][0].input.Key;
    expect(key).toEqual({ PK: 'SUPPORTER#sup-1', SK: 'USER#user-1' });
  });

  it('throws Unauthorized when the link is missing', async () => {
    mockSend.mockResolvedValue({ Item: undefined });
    await expect(assertCanAccessUserReports('sup-1', 'user-1')).rejects.toThrow('Unauthorized');
  });

  it('throws Unauthorized when the link is not ACTIVE', async () => {
    mockSend.mockResolvedValue({ Item: { status: 'PENDING' } });
    await expect(assertCanAccessUserReports('sup-1', 'user-1')).rejects.toThrow('Unauthorized');
  });
});
