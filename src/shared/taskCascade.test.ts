import { deleteTaskCascade } from './taskCascade';
import { dynamo } from './dynamodb';
import { deleteS3ObjectBestEffort } from './media';
import type { Task } from './types';

jest.mock('./dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

jest.mock('./media', () => ({
  deleteS3ObjectBestEffort: jest.fn().mockResolvedValue(true),
}));

const mockSend = dynamo.send as jest.Mock;
const mockDeleteS3 = deleteS3ObjectBestEffort as jest.Mock;

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({});
  mockDeleteS3.mockReset().mockResolvedValue(true);
});

const inputs = () => mockSend.mock.calls.map((c) => c[0].input);
const finalTx = () => inputs().find((i) => i.TransactItems);
const deleteBatches = () =>
  inputs().filter((i) => i.RequestItems?.['CanPlan-test']?.[0]?.DeleteRequest);

const meta = (extra: Record<string, unknown> = {}): Task =>
  ({
    PK: 'TASK#t1',
    SK: '#META',
    entityType: 'Task',
    taskId: 't1',
    ownerId: 'o1',
    title: 'T',
    categoryId: 'cat-1',
    taskCategoryKey: 'o1#cat-1',
    createdAt: 'c',
    ...extra,
  }) as unknown as Task;

describe('deleteTaskCascade', () => {
  it('returns null without writing when the task does not exist (idempotent)', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined }); // readTaskMeta → gone
    const result = await deleteTaskCascade('t1');
    expect(result).toBeNull();
    // Only the #META read happened; no deletes.
    expect(deleteBatches()).toHaveLength(0);
    expect(finalTx()).toBeUndefined();
  });

  it('reads #META itself when no task is supplied, then cascades', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: meta() }) // readTaskMeta
      .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#s1' }] }) // STEP# keys
      .mockResolvedValueOnce({ Items: [] }) // MEDIA# items
      .mockResolvedValueOnce({}) // children batchDelete
      .mockResolvedValueOnce({ Items: [] }) // cleanup query
      .mockResolvedValueOnce({}) // cleanup batchDelete
      .mockResolvedValueOnce({}); // final TransactWrite
    const result = await deleteTaskCascade('t1');
    expect(result?.taskId).toBe('t1');
    expect((result as unknown as Record<string, unknown>).taskCategoryKey).toBeUndefined();
  });

  it('deletes children + S3 binaries and decrements the category, skipping the #META read when task is supplied', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#s1' }] }) // STEP# keys
      .mockResolvedValueOnce({
        Items: [{ PK: 'TASK#t1', SK: 'MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }],
      }) // MEDIA# items
      .mockResolvedValueOnce({}) // journal batchPut
      .mockResolvedValueOnce({}) // children batchDelete
      .mockResolvedValueOnce({
        Items: [{ PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }],
      }) // cleanup query
      .mockResolvedValueOnce({}) // cleanup batchDelete
      .mockResolvedValueOnce({}); // final TransactWrite

    await deleteTaskCascade('t1', { task: meta() });

    // No GetCommand for #META (task supplied) — the first call is the STEP# Query.
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('QueryCommand');
    expect(mockDeleteS3).toHaveBeenCalledTimes(1);
    const tx = finalTx()!;
    expect(tx.TransactItems[0].Delete.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(tx.TransactItems[1].Update.Key.SK).toBe('CATEGORY#cat-1');
    expect(tx.TransactItems[1].Update.ExpressionAttributeValues[':delta']).toBe(-1);
    // The owner's profile task counter is decremented in the SAME transaction.
    const profileUpdate = tx.TransactItems.find(
      (t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === '#PROFILE',
    )!;
    expect(profileUpdate.Update.Key).toEqual({ PK: 'USER#o1', SK: '#PROFILE' });
    expect(profileUpdate.Update.UpdateExpression).toContain('ADD taskCount :negOne');
    expect(profileUpdate.Update.ExpressionAttributeValues[':negOne']).toBe(-1);
  });

  it('throws and never deletes #META when an S3 delete fails', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [] }) // STEP#
      .mockResolvedValueOnce({
        Items: [{ PK: 'TASK#t1', SK: 'MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }],
      }) // MEDIA#
      .mockResolvedValueOnce({}) // journal
      .mockResolvedValueOnce({}) // children delete
      .mockResolvedValueOnce({
        Items: [{ PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }],
      }); // cleanup query
    mockDeleteS3.mockResolvedValueOnce(false);
    await expect(deleteTaskCascade('t1', { task: meta() })).rejects.toThrow('could not be deleted');
    expect(finalTx()).toBeUndefined();
  });
});
