import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { deleteS3ObjectBestEffort } from '../../shared/media';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Connection, MediaAsset, MediaDownloadTarget, MediaUploadTarget } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

// S3 presigning is mocked: no real client, fixed bucket/TTL, fake signed URL.
jest.mock('../../shared/s3', () => ({
  s3: {},
  MEDIA_BUCKET: 'canplan-media-test',
  UPLOAD_URL_TTL_SECONDS: 900,
  DOWNLOAD_URL_TTL_SECONDS: 900,
}));

// Keep the real cover-image constants/helpers, but stub the S3 object delete so
// deleteMediaAsset's binary cleanup is observable without a real S3 client.
jest.mock('../../shared/media', () => ({
  ...jest.requireActual('../../shared/media'),
  deleteS3ObjectBestEffort: jest.fn().mockResolvedValue(true),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockSend = dynamo.send as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockDeleteS3 = deleteS3ObjectBestEffort as jest.Mock;

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

describe('media handler — getMediaDownloadUrl', () => {
  it('looks the asset up, then presigns a GET for its s3Key', async () => {
    mockSend.mockResolvedValueOnce({ Item: { assetId: 'a1', taskId: 't1', s3Key: 'media/t1/abc.png' } });
    const result = (await handler(
      event('getMediaDownloadUrl', { taskId: 't1', assetId: 'a1' }),
    )) as MediaDownloadTarget;

    // Asset lookup by PK/SK first.
    expect(lastInput().Key).toEqual({ PK: 'TASK#t1', SK: 'MEDIA#a1' });
    // Then a presigned GetObject for the asset's real s3Key.
    const [, command] = mockGetSignedUrl.mock.calls[0];
    expect(command.constructor.name).toBe('GetObjectCommand');
    expect(command.input.Bucket).toBe('canplan-media-test');
    expect(command.input.Key).toBe('media/t1/abc.png');
    expect(result.downloadUrl).toBe('https://signed.example/upload');
    expect(result.s3Key).toBe('media/t1/abc.png');
    expect(result.expiresIn).toBe(900);
  });

  it('throws NotFound when the asset does not exist (never signs an arbitrary key)', async () => {
    mockSend.mockResolvedValueOnce({}); // no Item
    await expect(handler(event('getMediaDownloadUrl', { taskId: 't1', assetId: 'missing' }))).rejects.toThrow(
      'media asset not found',
    );
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('validates taskId and assetId', async () => {
    await expect(handler(event('getMediaDownloadUrl', { assetId: 'a1' }))).rejects.toThrow('taskId is required');
    await expect(handler(event('getMediaDownloadUrl', { taskId: 't1' }))).rejects.toThrow('assetId is required');
  });
});

describe('media handler — createTaskCoverImageUploadUrl', () => {
  it('mints a presigned PUT to a temporary pending-key prefix (no taskId, no DynamoDB)', async () => {
    const result = (await handler(
      event('createTaskCoverImageUploadUrl', { input: { contentType: 'image/png' } }),
    )) as MediaUploadTarget;

    expect(result.s3Key).toMatch(/^media\/pending\/task-cover\/[0-9a-f-]{36}\.png$/);
    expect(result.uploadUrl).toBe('https://signed.example/upload');
    expect(result.expiresIn).toBe(900);
    const [, command] = mockGetSignedUrl.mock.calls[0];
    expect(command.constructor.name).toBe('PutObjectCommand');
    expect(command.input.Key).toBe(result.s3Key);
    expect(command.input.ContentType).toBe('image/png');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects non-image content types', async () => {
    await expect(
      handler(event('createTaskCoverImageUploadUrl', { input: { contentType: 'application/pdf' } })),
    ).rejects.toThrow('contentType must be one of');
    await expect(
      handler(event('createTaskCoverImageUploadUrl', { input: { contentType: 'video/mp4' } })),
    ).rejects.toThrow('contentType must be one of');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('requires a contentType', async () => {
    await expect(
      handler(event('createTaskCoverImageUploadUrl', { input: {} })),
    ).rejects.toThrow('contentType is required');
  });
});

describe('media handler — deleteMediaAsset', () => {
  const asset = { PK: 'TASK#t1', SK: 'MEDIA#a1', entityType: 'MediaAsset', assetId: 'a1', taskId: 't1', s3Key: 'media/t1/a1.png', type: 'IMAGE', ownerId: 'o1' };
  const commands = () => mockSend.mock.calls.map((c) => c[0]);
  const inputs = () => commands().map((c) => c.input);
  const updates = () => inputs().filter((i) => i.UpdateExpression);

  it('removes the MediaAsset row and its S3 object, returning it without internal fields', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...asset } }); // GET asset; rest default {}
    const result = (await handler(
      event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }),
    )) as MediaAsset;

    // Row deleted by its PK/SK (DeleteCommand, distinct from the initial GetCommand).
    const del = commands().find((c) => c.constructor.name === 'DeleteCommand')!;
    expect(del.input.Key).toEqual({ PK: 'TASK#t1', SK: 'MEDIA#a1' });
    // S3 binary deleted (best-effort helper) with the asset's key.
    expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/a1.png', expect.objectContaining({ taskId: 't1', assetId: 'a1' }));
    // Returned metadata is stripped of storage attributes.
    const out = result as unknown as Record<string, unknown>;
    expect(out.PK).toBeUndefined();
    expect(out.SK).toBeUndefined();
    expect(out.entityType).toBeUndefined();
    expect(result.assetId).toBe('a1');
  });

  it('clears Task.coverImageAssetId when it points at the deleted asset', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...asset } });
    await handler(event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }));

    const coverUpdate = updates().find((i) => i.UpdateExpression.includes('REMOVE coverImageAssetId'))!;
    expect(coverUpdate.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(coverUpdate.ConditionExpression).toBe('coverImageAssetId = :assetId');
    expect(coverUpdate.ExpressionAttributeValues).toEqual({ ':assetId': 'a1' });
  });

  it('proceeds when the asset is not the cover (ConditionalCheckFailed is swallowed)', async () => {
    const condFail = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
    mockSend
      .mockResolvedValueOnce({ Item: { ...asset } }) // GET
      .mockRejectedValueOnce(condFail) // clear-cover Update → not the cover
      .mockResolvedValueOnce({ Items: [] }) // step query
      .mockResolvedValueOnce({}); // delete row
    const result = (await handler(
      event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }),
    )) as MediaAsset;
    expect(result.assetId).toBe('a1');
    expect(mockDeleteS3).toHaveBeenCalled();
  });

  it('removes the assetId from every referencing TaskStep.mediaRefs', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...asset } }) // GET asset
      .mockResolvedValueOnce({}) // clear-cover Update
      .mockResolvedValueOnce({
        Items: [
          { stepId: 's1', order: 1, mediaRefs: ['a1', 'keep'] },
          { stepId: 's2', order: 2, mediaRefs: ['other'] },
        ],
      }) // step query
      .mockResolvedValue({}); // step update + row delete

    await handler(event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }));

    const stepUpdates = updates().filter((i) => i.UpdateExpression.includes('mediaRefs = :refs'));
    // Only the referencing step (order 1) is rewritten, with the assetId filtered out.
    expect(stepUpdates).toHaveLength(1);
    expect(stepUpdates[0].Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#001' });
    expect(stepUpdates[0].ExpressionAttributeValues[':refs']).toEqual(['keep']);
  });

  it('returns NotFound and deletes nothing when the asset does not exist', async () => {
    mockSend.mockResolvedValueOnce({}); // GET → no Item
    await expect(
      handler(event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'gone' } })),
    ).rejects.toThrow('media asset not found');
    expect(mockDeleteS3).not.toHaveBeenCalled();
  });

  it('validates taskId and assetId', async () => {
    await expect(handler(event('deleteMediaAsset', { input: { assetId: 'a1' } }))).rejects.toThrow('taskId is required');
    await expect(handler(event('deleteMediaAsset', { input: { taskId: 't1' } }))).rejects.toThrow('assetId is required');
  });
});
