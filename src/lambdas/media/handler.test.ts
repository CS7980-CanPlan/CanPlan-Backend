import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Connection, MediaAsset, MediaUploadTarget } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

// S3 presigning is mocked: no real client, fixed bucket/TTL, fake signed URL.
jest.mock('../../shared/s3', () => ({
  s3: {},
  MEDIA_BUCKET: 'canplan-media-test',
  UPLOAD_URL_TTL_SECONDS: 900,
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockSend = dynamo.send as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;

beforeEach(() => {
  mockSend.mockResolvedValue({});
  mockGetSignedUrl.mockResolvedValue('https://signed.example/upload');
});
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
    const result = (await handler(event('listMediaForTask', { taskId: 't1' }))) as Connection<unknown>;
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':pk': 'TASK#t1', ':prefix': 'MEDIA#' });
    expect(result.items).toHaveLength(1);
  });
});

describe('media handler — createMediaUploadUrl', () => {
  it('mints a presigned PUT URL + server-owned s3Key under media/<taskId>/', async () => {
    const result = (await handler(
      event('createMediaUploadUrl', { input: { taskId: 't1', contentType: 'image/png', fileName: 'photo.png' } }),
    )) as MediaUploadTarget;

    expect(result.uploadUrl).toBe('https://signed.example/upload');
    expect(result.s3Key).toMatch(/^media\/t1\/[0-9a-f-]{36}\.png$/);
    expect(result.expiresIn).toBe(900);

    // Presigned for a PutObject to the media bucket, keyed + content-typed to match.
    const [, command, opts] = mockGetSignedUrl.mock.calls[0];
    expect(command.input.Bucket).toBe('canplan-media-test');
    expect(command.input.Key).toBe(result.s3Key);
    expect(command.input.ContentType).toBe('image/png');
    expect(opts.expiresIn).toBe(900);
    // It must not touch DynamoDB — registration is a separate createMediaAsset call.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('derives the extension from contentType when no fileName is given', async () => {
    const result = (await handler(
      event('createMediaUploadUrl', { input: { taskId: 't1', contentType: 'image/jpeg' } }),
    )) as MediaUploadTarget;
    expect(result.s3Key).toMatch(/\.jpeg$/);
  });

  it('validates taskId and contentType', async () => {
    await expect(
      handler(event('createMediaUploadUrl', { input: { contentType: 'image/png' } })),
    ).rejects.toThrow('taskId is required');
    await expect(
      handler(event('createMediaUploadUrl', { input: { taskId: 't1' } })),
    ).rejects.toThrow('contentType is required');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
