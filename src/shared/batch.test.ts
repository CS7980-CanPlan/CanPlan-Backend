import { batchDelete, batchPut, BATCH_WRITE_LIMIT, queryAllKeys } from './batch';
import { dynamo } from './dynamodb';

jest.mock('./dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

const inputs = () => mockSend.mock.calls.map((c) => c[0].input);

describe('queryAllKeys', () => {
  it('follows pagination and returns only PK/SK', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ PK: 'TASK#t1', SK: 'STEP#001', text: 'ignored' }],
        LastEvaluatedKey: { PK: 'TASK#t1', SK: 'STEP#001' },
      })
      .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#002' }] });

    const keys = await queryAllKeys('TASK#t1', 'STEP#');

    expect(keys).toEqual([
      { PK: 'TASK#t1', SK: 'STEP#001' },
      { PK: 'TASK#t1', SK: 'STEP#002' },
    ]);
    // Projects keys only.
    expect(inputs()[0].ProjectionExpression).toBe('PK, SK');
    // Second call passed the first page's LastEvaluatedKey as the start key.
    expect(inputs()[1].ExclusiveStartKey).toEqual({ PK: 'TASK#t1', SK: 'STEP#001' });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array when there are no rows', async () => {
    expect(await queryAllKeys('TASK#t1', 'STEP#')).toEqual([]);
  });
});

describe('batchDelete', () => {
  it('chunks deletes into groups of 25 (transaction-limit-safe for many rows)', async () => {
    const keys = Array.from({ length: 60 }, (_, i) => ({ PK: 'TASK#t1', SK: `STEP#${i}` }));
    await batchDelete(keys);

    // 60 / 25 → 3 BatchWrite calls (25 + 25 + 10).
    expect(mockSend).toHaveBeenCalledTimes(3);
    const sizes = inputs().map((i) => i.RequestItems['CanPlan-test'].length);
    expect(sizes).toEqual([BATCH_WRITE_LIMIT, BATCH_WRITE_LIMIT, 10]);
    // Each request is a DeleteRequest keyed by PK/SK.
    expect(inputs()[0].RequestItems['CanPlan-test'][0]).toEqual({
      DeleteRequest: { Key: { PK: 'TASK#t1', SK: 'STEP#0' } },
    });
  });

  it('does nothing (no calls) for an empty key list', async () => {
    await batchDelete([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('retries UnprocessedItems returned under throttling', async () => {
    mockSend
      .mockResolvedValueOnce({
        UnprocessedItems: { 'CanPlan-test': [{ DeleteRequest: { Key: { PK: 'p', SK: 's' } } }] },
      })
      .mockResolvedValueOnce({});
    await batchDelete([{ PK: 'p', SK: 's' }]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('throws if items remain unprocessed after the retry budget', async () => {
    mockSend.mockResolvedValue({
      UnprocessedItems: { 'CanPlan-test': [{ DeleteRequest: { Key: { PK: 'p', SK: 's' } } }] },
    });
    await expect(batchDelete([{ PK: 'p', SK: 's' }])).rejects.toThrow('still unprocessed');
  });
});

describe('batchPut', () => {
  it('chunks puts into groups of 25', async () => {
    const items = Array.from({ length: 26 }, (_, i) => ({ PK: 'TASK#t1', SK: `CLEANUP#${i}` }));
    await batchPut(items);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(inputs().map((i) => i.RequestItems['CanPlan-test'].length)).toEqual([25, 1]);
    expect(inputs()[0].RequestItems['CanPlan-test'][0]).toEqual({
      PutRequest: { Item: { PK: 'TASK#t1', SK: 'CLEANUP#0' } },
    });
  });
});
