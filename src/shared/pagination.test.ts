import { decodeNextToken, encodeNextToken, pageArgs, queryPage } from './pagination';
import { dynamo } from './dynamodb';

jest.mock('./dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;
afterEach(() => jest.clearAllMocks());

describe('pagination tokens', () => {
  it('round-trips a DynamoDB key through encode/decode', () => {
    const key = { PK: 'TASK#t1', SK: '#META', entityType: 'Task', createdAt: '2026-06-15T10:00:00Z' };
    const token = encodeNextToken(key);
    expect(typeof token).toBe('string');
    expect(decodeNextToken(token)).toEqual(key);
  });

  it('encodes a missing key as null (no more pages)', () => {
    expect(encodeNextToken(undefined)).toBeNull();
  });

  it('decodes empty/undefined tokens to undefined (start from the beginning)', () => {
    expect(decodeNextToken(undefined)).toBeUndefined();
    expect(decodeNextToken(null)).toBeUndefined();
    expect(decodeNextToken('')).toBeUndefined();
  });

  it('throws a ValidationError on a malformed token', () => {
    expect(() => decodeNextToken('!!!not-base64-json!!!')).toThrow('invalid nextToken');
  });
});

describe('pageArgs', () => {
  it('extracts a numeric limit and string nextToken', () => {
    expect(pageArgs({ limit: 25, nextToken: 'abc' })).toEqual({ limit: 25, nextToken: 'abc' });
  });

  it('ignores wrong-typed or missing values', () => {
    expect(pageArgs({ limit: '25', nextToken: 123 })).toEqual({ limit: undefined, nextToken: undefined });
    expect(pageArgs({})).toEqual({ limit: undefined, nextToken: undefined });
  });
});

describe('queryPage', () => {
  const baseInput = {
    TableName: 'CanPlan-test',
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'x' },
  };

  it('forwards the query, injects a positive Limit + decoded ExclusiveStartKey, and encodes the next token', async () => {
    const lek = { PK: 'last', SK: 'key' };
    const startKey = { PK: 'start', SK: 's' };
    mockSend.mockResolvedValueOnce({ Items: [{ a: 1 }], LastEvaluatedKey: lek });

    const result = await queryPage(baseInput, { limit: 5, nextToken: encodeNextToken(startKey)! });

    const input = mockSend.mock.calls[0][0].input;
    expect(input.KeyConditionExpression).toBe('PK = :pk');
    expect(input.Limit).toBe(5);
    expect(input.ExclusiveStartKey).toEqual(startKey);
    expect(result.items).toEqual([{ a: 1 }]);
    expect(decodeNextToken(result.nextToken)).toEqual(lek);
  });

  it('omits Limit when not positive and returns a null nextToken on the last page', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const result = await queryPage(baseInput, { limit: 0 });
    const input = mockSend.mock.calls[0][0].input;
    expect(input.Limit).toBeUndefined();
    expect(input.ExclusiveStartKey).toBeUndefined();
    expect(result.items).toEqual([]);
    expect(result.nextToken).toBeNull();
  });
});
