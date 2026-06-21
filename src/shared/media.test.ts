import {
  ALLOWED_IMAGE_MIME_TYPES,
  deleteS3ObjectBestEffort,
  isPendingCoverKey,
  MAX_COVER_IMAGE_BYTES,
  PENDING_COVER_PREFIX,
  prepareCoverImageAsset,
} from './media';
import { s3 } from './s3';

jest.mock('./s3', () => ({
  s3: { send: jest.fn() },
  MEDIA_BUCKET: 'canplan-media-test',
}));

const mockSend = s3.send as unknown as jest.Mock;

/** Resolve HeadObject with the given result; everything else (Copy/Delete) → {}. */
function stubHead(head: Record<string, unknown>) {
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === 'HeadObjectCommand' ? Promise.resolve(head) : Promise.resolve({}),
  );
}
const sentCommands = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

beforeEach(() => mockSend.mockReset());
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
    expect(sentCommands()).toEqual(['HeadObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand']);
    const copy = mockSend.mock.calls.find((c) => c[0].constructor.name === 'CopyObjectCommand')![0];
    expect(copy.input.Key).toBe(asset.s3Key);
    expect(copy.input.CopySource).toBe(`canplan-media-test/${PENDING}`);
    const del = mockSend.mock.calls.find((c) => c[0].constructor.name === 'DeleteObjectCommand')![0];
    expect(del.input.Key).toBe(PENDING); // temp object cleaned up
  });

  it('still succeeds if temp cleanup fails (best-effort; lifecycle reclaims it)', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'HeadObjectCommand') {
        return Promise.resolve({ ContentType: 'image/jpeg', ContentLength: 10 });
      }
      if (cmd.constructor.name === 'DeleteObjectCommand') return Promise.reject(new Error('s3 down'));
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
