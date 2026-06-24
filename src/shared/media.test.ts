import {
  ALLOWED_IMAGE_MIME_TYPES,
  clearTaskCoverReference,
  deleteS3ObjectBestEffort,
  isPendingCoverKey,
  MAX_COVER_IMAGE_BYTES,
  PENDING_COVER_PREFIX,
  prepareCoverImageAsset,
  purgeMediaAsset,
  retryTaskMediaCleanup,
} from './media';
import { dynamo } from './dynamodb';
import { s3 } from './s3';

jest.mock('./s3', () => ({
  s3: { send: jest.fn() },
  MEDIA_BUCKET: 'canplan-media-test',
}));

jest.mock('./dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = s3.send as unknown as jest.Mock;
const mockDynamo = dynamo.send as unknown as jest.Mock;

/** Resolve HeadObject with the given result; everything else (Copy/Delete) → {}. */
function stubHead(head: Record<string, unknown>) {
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === 'HeadObjectCommand' ? Promise.resolve(head) : Promise.resolve({}),
  );
}
const sentCommands = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

beforeEach(() => {
  mockSend.mockReset();
  mockDynamo.mockReset();
  mockDynamo.mockResolvedValue({});
});
afterEach(() => jest.restoreAllMocks());

const PENDING = `${PENDING_COVER_PREFIX}11111111-1111-1111-1111-111111111111.png`;

describe('isPendingCoverKey', () => {
  it('accepts exactly one segment under the pending prefix', () => {
    expect(isPendingCoverKey(PENDING)).toBe(true);
  });
  it('rejects arbitrary, non-pending, or nested keys', () => {
    expect(isPendingCoverKey('media/t1/abc.png')).toBe(false); // not pending
    expect(isPendingCoverKey('media/pending/task-cover/')).toBe(false); // empty segment
    expect(isPendingCoverKey(`${PENDING_COVER_PREFIX}sub/abc.png`)).toBe(false); // nested
    expect(isPendingCoverKey('secret/keys.txt')).toBe(false);
  });
});

describe('prepareCoverImageAsset', () => {
  const base = { taskId: 't1', ownerId: 'o1' };

  it('rejects an arbitrary (non-pending) s3Key without touching S3', async () => {
    await expect(
      prepareCoverImageAsset({ ...base, coverImageS3Key: 'media/t1/evil.png' }),
    ).rejects.toThrow('must be a pending upload');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects when the uploaded object does not exist', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotFound' }));
    await expect(prepareCoverImageAsset({ ...base, coverImageS3Key: PENDING })).rejects.toThrow(
      'uploaded cover image not found',
    );
    // Never copied an unverified object.
    expect(sentCommands()).not.toContain('CopyObjectCommand');
  });

  it('rejects a non-image MIME type (ignores client claims, trusts HeadObject)', async () => {
    stubHead({ ContentType: 'image/gif', ContentLength: 1000 });
    await expect(prepareCoverImageAsset({ ...base, coverImageS3Key: PENDING })).rejects.toThrow(
      'cover image must be one of',
    );
    expect(sentCommands()).not.toContain('CopyObjectCommand');
  });

  it('rejects a zero-byte object', async () => {
    stubHead({ ContentType: 'image/png', ContentLength: 0 });
    await expect(prepareCoverImageAsset({ ...base, coverImageS3Key: PENDING })).rejects.toThrow(
      'zero bytes',
    );
  });

  it('rejects an object larger than 10 MB', async () => {
    stubHead({ ContentType: 'image/png', ContentLength: MAX_COVER_IMAGE_BYTES + 1 });
    await expect(prepareCoverImageAsset({ ...base, coverImageS3Key: PENDING })).rejects.toThrow(
      '10 MB',
    );
  });

  it('copies the verified object to a task-owned key and returns the IMAGE MediaAsset', async () => {
    stubHead({ ContentType: 'image/png', ContentLength: 2048 });
    const asset = await prepareCoverImageAsset({ ...base, coverImageS3Key: PENDING });

    expect(asset.type).toBe('IMAGE');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.size).toBe(2048);
    expect(asset.ownerId).toBe('o1');
    expect(asset.taskId).toBe('t1');
    expect(asset.stepId).toBeUndefined(); // cover image has no stepId
    expect(asset.s3Key).toBe(`media/t1/${asset.assetId}.png`);

    // Verify → copy to final → delete temp.
    expect(sentCommands()).toEqual([
      'HeadObjectCommand',
      'CopyObjectCommand',
      'DeleteObjectCommand',
    ]);
    const copy = mockSend.mock.calls.find((c) => c[0].constructor.name === 'CopyObjectCommand')![0];
    expect(copy.input.Key).toBe(asset.s3Key);
    expect(copy.input.CopySource).toBe(`canplan-media-test/${PENDING}`);
    const del = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'DeleteObjectCommand',
    )![0];
    expect(del.input.Key).toBe(PENDING); // temp object cleaned up
  });

  it('still succeeds if temp cleanup fails (best-effort; lifecycle reclaims it)', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'HeadObjectCommand') {
        return Promise.resolve({ ContentType: 'image/jpeg', ContentLength: 10 });
      }
      if (cmd.constructor.name === 'DeleteObjectCommand')
        return Promise.reject(new Error('s3 down'));
      return Promise.resolve({});
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const asset = await prepareCoverImageAsset({ ...base, coverImageS3Key: PENDING });
    expect(asset.s3Key).toMatch(/\.jpg$/);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('deleteS3ObjectBestEffort', () => {
  it('returns true on success', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await deleteS3ObjectBestEffort('media/t1/a.png')).toBe(true);
  });

  it('logs context and returns false on failure (never throws)', async () => {
    mockSend.mockRejectedValueOnce(new Error('access denied'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await deleteS3ObjectBestEffort('media/t1/a.png', { taskId: 't1', assetId: 'a1' });
    expect(ok).toBe(false);
    const logged = errSpy.mock.calls[0][0] as string;
    expect(logged).toContain('t1');
    expect(logged).toContain('a1');
    expect(logged).toContain('media/t1/a.png');
  });
});

describe('module constants', () => {
  it('allows only jpeg/png/webp', () => {
    expect([...ALLOWED_IMAGE_MIME_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});

// ── Media-cleanup service (shared by deleteMediaAsset + deleteTaskStep) ───────────
describe('clearTaskCoverReference', () => {
  it('conditionally REMOVEs coverImageAssetId only when it matches', async () => {
    await clearTaskCoverReference('t1', 'a1');
    const input = mockDynamo.mock.calls[0][0].input;
    expect(input.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(input.UpdateExpression).toBe('REMOVE coverImageAssetId');
    expect(input.ConditionExpression).toBe('coverImageAssetId = :assetId');
    expect(input.ExpressionAttributeValues).toEqual({ ':assetId': 'a1' });
  });

  it('swallows ConditionalCheckFailed (asset is not the cover)', async () => {
    mockDynamo.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(clearTaskCoverReference('t1', 'a1')).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    mockDynamo.mockRejectedValueOnce(new Error('boom'));
    await expect(clearTaskCoverReference('t1', 'a1')).rejects.toThrow('boom');
  });
});

describe('purgeMediaAsset', () => {
  const asset = { taskId: 't1', assetId: 'a1', s3Key: 'media/t1/a1.png' };

  it('clears a cover back-ref, deletes the row, deletes the S3 object, returns true', async () => {
    mockDynamo.mockResolvedValue({});
    mockSend.mockResolvedValue({}); // S3 DeleteObject
    const ok = await purgeMediaAsset(asset, { event: 'deleteTaskStep' });

    expect(ok).toBe(true);
    const dynamoInputs = mockDynamo.mock.calls.map((c) => c[0].input);
    // Cover-ref clear happened; Step media is derived from MediaAsset.stepId and needs no
    // TaskStep rewrite.
    expect(dynamoInputs.some((i) => i.UpdateExpression === 'REMOVE coverImageAssetId')).toBe(true);
    const rowDelete = mockDynamo.mock.calls
      .map((c) => c[0])
      .find((c) => c.constructor.name === 'DeleteCommand');
    expect(rowDelete.input.Key).toEqual({ PK: 'TASK#t1', SK: 'MEDIA#a1' });
    // The durable journal is removed only after the S3 object is deleted.
    const inputs = mockDynamo.mock.calls.map((c) => c[0].input);
    expect(inputs.some((i) => i.Item?.SK === 'CLEANUP_MEDIA#a1')).toBe(true);
    expect(inputs.some((i) => i.Key?.SK === 'CLEANUP_MEDIA#a1')).toBe(true);
    const s3Del = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'DeleteObjectCommand',
    )![0];
    expect(s3Del.input.Key).toBe('media/t1/a1.png');
  });

  it('returns false (but still removes the row) when the S3 delete fails — partial, logged', async () => {
    mockDynamo.mockResolvedValue({});
    mockSend.mockRejectedValue(new Error('s3 down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await purgeMediaAsset(asset, { event: 'deleteTaskStep' });
    expect(ok).toBe(false);
    // Row still deleted (DB-first); failure logged with context for retry.
    expect(
      mockDynamo.mock.calls.map((c) => c[0]).some((c) => c.constructor.name === 'DeleteCommand'),
    ).toBe(true);
    expect(errSpy.mock.calls[0][0]).toContain('media/t1/a1.png');
    // The journal survives, preserving the S3 key for a later retry.
    const inputs = mockDynamo.mock.calls.map((c) => c[0].input);
    expect(inputs.some((i) => i.Item?.SK === 'CLEANUP_MEDIA#a1')).toBe(true);
    expect(inputs.some((i) => i.Key?.SK === 'CLEANUP_MEDIA#a1')).toBe(false);
  });
});

describe('retryTaskMediaCleanup', () => {
  it('deletes a journaled S3 object and removes its journal after a previous failure', async () => {
    mockDynamo.mockResolvedValueOnce({
      Items: [{ PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#a1', assetId: 'a1', s3Key: 'media/t1/a1.png' }],
    });
    mockSend.mockResolvedValueOnce({});

    await expect(retryTaskMediaCleanup('t1', { event: 'retry-test' })).resolves.toBe(true);

    const inputs = mockDynamo.mock.calls.map((c) => c[0].input);
    expect(inputs[0].ExpressionAttributeValues).toEqual({
      ':pk': 'TASK#t1',
      ':prefix': 'CLEANUP_MEDIA#',
    });
    expect(inputs.some((i) => i.Key?.SK === 'CLEANUP_MEDIA#a1')).toBe(true);
  });

  it('retains the journal and returns false when the S3 retry fails', async () => {
    mockDynamo.mockResolvedValueOnce({
      Items: [{ PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#a1', assetId: 'a1', s3Key: 'media/t1/a1.png' }],
    });
    mockSend.mockRejectedValueOnce(new Error('s3 down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(retryTaskMediaCleanup('t1')).resolves.toBe(false);
    const inputs = mockDynamo.mock.calls.map((c) => c[0].input);
    expect(inputs.some((i) => i.Key?.SK === 'CLEANUP_MEDIA#a1')).toBe(false);
  });
});
