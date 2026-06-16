import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { MediaAsset } from '../../shared/types';

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

function mediaInput(overrides: Record<string, unknown> = {}) {
  return { taskId: 't1', s3Key: 'media/t1/a.bin', type: 'IMAGE', mimeType: 'image/png', ownerId: 'o1', ...overrides };
}

describe('media handler', () => {
  it('createMediaAsset writes PK=TASK#<id>, SK=MEDIA#<assetId> with S3 metadata only', async () => {
    const result = (await handler(
      event('createMediaAsset', { input: mediaInput({ size: 2048, stepId: 'st1' }) }),
    )) as MediaAsset;
    const { Item } = lastInput();
    expect(Item.PK).toBe('TASK#t1');
    expect(Item.SK).toBe(`MEDIA#${Item.assetId}`);
    expect(result.assetId).toBe(Item.assetId);
    expect(Item.entityType).toBe('MediaAsset');
    expect(Item.s3Key).toBe('media/t1/a.bin');
    expect(Item.mimeType).toBe('image/png');
    expect(Item.ownerId).toBe('o1');
    expect(Item.stepId).toBe('st1');
    expect(Item.size).toBe(2048);
  });

  it.each(['IMAGE', 'AUDIO', 'VIDEO'])('createMediaAsset supports the %s media type', async (type) => {
    const result = (await handler(event('createMediaAsset', { input: mediaInput({ type }) }))) as MediaAsset;
    expect(result.type).toBe(type);
    expect(lastInput().Item.type).toBe(type);
  });

  it('createMediaAsset validates the required S3 metadata', async () => {
    await expect(handler(event('createMediaAsset', { input: mediaInput({ taskId: '' }) }))).rejects.toThrow(
      'taskId is required',
    );
    await expect(handler(event('createMediaAsset', { input: mediaInput({ s3Key: '' }) }))).rejects.toThrow(
      's3Key is required',
    );
    await expect(handler(event('createMediaAsset', { input: mediaInput({ ownerId: '' }) }))).rejects.toThrow(
      'ownerId is required',
    );
  });

  it('listMediaForTask queries PK=TASK#<id> with SK begins_with MEDIA#', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ assetId: 'a1' }] });
    const result = await handler(event('listMediaForTask', { taskId: 't1' }));
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':pk': 'TASK#t1', ':prefix': 'MEDIA#' });
    expect(result).toHaveLength(1);
  });
});
