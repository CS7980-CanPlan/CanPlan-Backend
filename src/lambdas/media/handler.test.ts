import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { assertCanActForUser } from '../../shared/delegation';
import { purgeMediaAsset } from '../../shared/media';
import { UnauthorizedError } from '../../shared/response';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Connection, MediaAsset, MediaDownloadTarget, MediaUploadTarget } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

// Manage-access authorization (owner or delegated SupportPerson) for media WRITES is
// unit-tested in shared/delegation.test.ts; here `assertCanActForUser` is mocked to resolve by
// default and overridden to reject for denial tests. The READ path (`assertCanReadTaskById` /
// `assertCanReadTask`) keeps its real implementation via requireActual, driven by mocked dynamo.
jest.mock('../../shared/delegation', () => {
  const actual = jest.requireActual('../../shared/delegation');
  return { ...actual, assertCanActForUser: jest.fn() };
});

// S3 presigning is mocked: no real client, fixed bucket/TTL, fake signed URL.
jest.mock('../../shared/s3', () => ({
  s3: {},
  MEDIA_BUCKET: 'canplan-media-test',
  UPLOAD_URL_TTL_SECONDS: 900,
  DOWNLOAD_URL_TTL_SECONDS: 900,
}));

// Keep the real cover-image constants/helpers, but stub the shared media-purge service
// (its internals — ref clearing, row + S3 delete — are unit-tested in shared/media.test.ts).
jest.mock('../../shared/media', () => ({
  ...jest.requireActual('../../shared/media'),
  purgeMediaAsset: jest.fn().mockResolvedValue(true),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockSend = dynamo.send as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockPurge = purgeMediaAsset as jest.Mock;
const mockAssertCanAct = assertCanActForUser as jest.Mock;

const OWNER = 'o1';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose mock helpers

/**
 * Route dynamo.send by command type. Media ops are owner-scoped, so most read the task #META
 * for the authoritative owner first; reads also allow a holder of an active assignment.
 *  - taskMeta: the #META row (default: a task owned by OWNER). Set to undefined for "missing".
 *  - asset: the MEDIA# GET result.
 *  - mediaList: the MEDIA# Query (listMediaForTask) result.
 *  - activeAssignments: rows the TASK_ASSIGNMENT# delegation Query returns (each carries PK + taskId + active).
 */
interface DbState {
  taskMeta?: Rec;
  asset?: Rec;
  mediaList?: Rec[];
  activeAssignments?: Rec[];
}
let db: DbState;

beforeEach(() => {
  db = { taskMeta: { taskId: 't1', ownerId: OWNER } };
  mockGetSignedUrl.mockResolvedValue('https://signed.example/upload');
  mockPurge.mockResolvedValue(true);
  // Default: the caller may manage the task's owner (self or active delegation).
  mockAssertCanAct.mockResolvedValue(OWNER);
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
    const name = cmd.constructor.name;
    const input = cmd.input;
    if (name === 'GetCommand') {
      const sk: string = input.Key.SK;
      if (sk === '#META') return Promise.resolve({ Item: db.taskMeta });
      if (sk.startsWith('MEDIA#')) return Promise.resolve({ Item: db.asset });
      return Promise.resolve({});
    }
    if (name === 'QueryCommand') {
      const values: Rec = input.ExpressionAttributeValues ?? {};
      if (values[':prefix'] === 'TASK_ASSIGNMENT#') {
        const items = (db.activeAssignments ?? []).filter(
          (a) => a.PK === values[':pk'] && a.taskId === values[':taskId'] && a.active === true,
        );
        return Promise.resolve({ Items: items });
      }
      return Promise.resolve({ Items: db.mediaList ?? [] });
    }
    return Promise.resolve({}); // Put / Delete
  });
});
afterEach(() => jest.clearAllMocks());

/** Identity defaults to the task owner; pass another sub to test cross-owner denial. */
function event(fieldName: string, args: Record<string, unknown>, sub: string | null = OWNER) {
  return {
    arguments: args,
    info: { fieldName },
    identity: sub ? { sub } : undefined,
  } as Parameters<typeof handler>[0];
}

const calls = () => mockSend.mock.calls.map((c) => c[0]);
const byCommand = (name: string): Rec[] =>
  calls().filter((c) => c.constructor.name === name).map((c) => c.input);
/** The MEDIA# GetCommand (asset lookup), skipping the #META ownership read. */
const assetGet = (): Rec | undefined =>
  byCommand('GetCommand').find((i) => String(i.Key.SK).startsWith('MEDIA#'));

function mediaInput(overrides: Record<string, unknown> = {}) {
  return { taskId: 't1', s3Key: 'media/t1/a.bin', type: 'IMAGE', mimeType: 'image/png', ownerId: 'o1', ...overrides };
}

describe('media handler — createMediaAsset (owner or delegated SupportPerson)', () => {
  it('writes PK=TASK#<id>, SK=MEDIA#<assetId>, UNATTACHED (no stepId)', async () => {
    const result = (await handler(
      event('createMediaAsset', { input: mediaInput({ size: 2048 }) }),
    )) as MediaAsset;
    const { Item } = byCommand('PutCommand')[0];
    expect(Item.PK).toBe('TASK#t1');
    expect(Item.SK).toBe(`MEDIA#${Item.assetId}`);
    expect(result.assetId).toBe(Item.assetId);
    expect(Item.entityType).toBe('MediaAsset');
    expect(Item.s3Key).toBe('media/t1/a.bin');
    expect(Item.mimeType).toBe('image/png');
    expect(Item.ownerId).toBe('o1');
    // Newly registered media is unattached — bound to a step only via updateTaskStep.
    expect(Item.stepId).toBeUndefined();
    expect(Item.size).toBe(2048);
  });

  it('ignores any client-supplied stepId (assets are created unattached)', async () => {
    await handler(event('createMediaAsset', { input: mediaInput({ stepId: 'st1' }) }));
    expect(byCommand('PutCommand')[0].Item.stepId).toBeUndefined();
  });

  it.each(['IMAGE', 'AUDIO', 'VIDEO'])('supports the %s media type', async (type) => {
    const result = (await handler(event('createMediaAsset', { input: mediaInput({ type }) }))) as MediaAsset;
    expect(result.type).toBe(type);
    expect(byCommand('PutCommand')[0].Item.type).toBe(type);
  });

  it('validates the required S3 metadata', async () => {
    await expect(handler(event('createMediaAsset', { input: mediaInput({ taskId: '' }) }))).rejects.toThrow(
      'taskId is required',
    );
    await expect(handler(event('createMediaAsset', { input: mediaInput({ s3Key: '' }) }))).rejects.toThrow(
      's3Key is required',
    );
  });

  it('derives the asset owner from the task, ignoring a client-supplied ownerId', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'pu-1' };
    // A malicious/mismatched input.ownerId must NOT be trusted — the stored owner is the task's.
    const result = (await handler(
      event('createMediaAsset', { input: mediaInput({ ownerId: 'victim' }) }, 'sup-1'),
    )) as MediaAsset;
    expect(byCommand('PutCommand')[0].Item.ownerId).toBe('pu-1');
    expect(result.ownerId).toBe('pu-1');
  });

  it('lets a delegated SupportPerson register media under a primary user’s task', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'pu-1' };
    const result = (await handler(
      event('createMediaAsset', { input: mediaInput({ ownerId: undefined }) }, 'sup-1'),
    )) as MediaAsset;
    // Authorized against the task's owner (pu-1), not the caller; asset owner is pu-1.
    expect(mockAssertCanAct).toHaveBeenCalledWith(expect.objectContaining({ sub: 'sup-1' }), 'pu-1');
    expect(byCommand('PutCommand')[0].Item.ownerId).toBe('pu-1');
    expect(result.ownerId).toBe('pu-1');
  });

  it('rejects a caller who cannot manage the task, writing nothing', async () => {
    mockAssertCanAct.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(
      handler(event('createMediaAsset', { input: mediaInput() }, 'intruder')),
    ).rejects.toThrow('no active support link');
    expect(byCommand('PutCommand')).toHaveLength(0);
  });

  it('404s when the referenced task does not exist', async () => {
    db.taskMeta = undefined;
    await expect(handler(event('createMediaAsset', { input: mediaInput() }))).rejects.toThrow(
      'task t1 not found',
    );
  });
});

describe('media handler — listMediaForTask (owner or assigned)', () => {
  it('queries PK=TASK#<id> with SK begins_with MEDIA# for the owner', async () => {
    db.mediaList = [{ assetId: 'a1' }];
    const result = (await handler(event('listMediaForTask', { taskId: 't1' }))) as Connection<unknown>;
    const query = byCommand('QueryCommand').find((i) => i.ExpressionAttributeValues[':prefix'] === 'MEDIA#');
    expect(query?.ExpressionAttributeValues).toEqual({ ':pk': 'TASK#t1', ':prefix': 'MEDIA#' });
    expect(result.items).toHaveLength(1);
  });

  it('allows a non-owner who holds an active assignment referencing the task', async () => {
    db.mediaList = [{ assetId: 'a1' }];
    db.activeAssignments = [{ PK: 'USER#assignee', taskId: 't1', active: true }];
    const result = (await handler(
      event('listMediaForTask', { taskId: 't1' }, 'assignee'),
    )) as Connection<unknown>;
    expect(result.items).toHaveLength(1);
  });

  it('rejects a non-owner with no assignment referencing the task', async () => {
    await expect(handler(event('listMediaForTask', { taskId: 't1' }, 'intruder'))).rejects.toThrow(
      'does not own this task',
    );
  });
});

describe('media handler — createMediaUploadUrl (owner or delegated SupportPerson)', () => {
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
    // It checks ownership (a #META read) but registers nothing — that's a separate createMediaAsset.
    expect(byCommand('PutCommand')).toHaveLength(0);
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

  it('rejects a caller who cannot manage the task', async () => {
    mockAssertCanAct.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(
      handler(event('createMediaUploadUrl', { input: { taskId: 't1', contentType: 'image/png' } }, 'intruder')),
    ).rejects.toThrow('no active support link');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('lets a delegated SupportPerson mint an upload URL for a primary user’s task', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'pu-1' };
    const result = (await handler(
      event('createMediaUploadUrl', { input: { taskId: 't1', contentType: 'image/png' } }, 'sup-1'),
    )) as MediaUploadTarget;
    expect(mockAssertCanAct).toHaveBeenCalledWith(expect.objectContaining({ sub: 'sup-1' }), 'pu-1');
    expect(result.uploadUrl).toBeDefined();
  });
});

describe('media handler — getMediaDownloadUrl (owner or assigned)', () => {
  it('looks the asset up, then presigns a GET for its s3Key (owner)', async () => {
    db.asset = { assetId: 'a1', taskId: 't1', s3Key: 'media/t1/abc.png' };
    const result = (await handler(
      event('getMediaDownloadUrl', { taskId: 't1', assetId: 'a1' }),
    )) as MediaDownloadTarget;

    // Asset lookup by PK/SK (after the ownership read).
    expect(assetGet()?.Key).toEqual({ PK: 'TASK#t1', SK: 'MEDIA#a1' });
    // Then a presigned GetObject for the asset's real s3Key.
    const [, command] = mockGetSignedUrl.mock.calls[0];
    expect(command.constructor.name).toBe('GetObjectCommand');
    expect(command.input.Bucket).toBe('canplan-media-test');
    expect(command.input.Key).toBe('media/t1/abc.png');
    expect(result.downloadUrl).toBe('https://signed.example/upload');
    expect(result.s3Key).toBe('media/t1/abc.png');
    expect(result.expiresIn).toBe(900);
  });

  it('allows an assigned primary user to download (read-only delegation)', async () => {
    db.asset = { assetId: 'a1', taskId: 't1', s3Key: 'media/t1/abc.png' };
    db.activeAssignments = [{ PK: 'USER#assignee', taskId: 't1', active: true }];
    const result = (await handler(
      event('getMediaDownloadUrl', { taskId: 't1', assetId: 'a1' }, 'assignee'),
    )) as MediaDownloadTarget;
    expect(result.s3Key).toBe('media/t1/abc.png');
  });

  it('rejects a non-owner with no assignment referencing the task', async () => {
    db.asset = { assetId: 'a1', taskId: 't1', s3Key: 'media/t1/abc.png' };
    await expect(
      handler(event('getMediaDownloadUrl', { taskId: 't1', assetId: 'a1' }, 'intruder')),
    ).rejects.toThrow('does not own this task');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('throws NotFound when the asset does not exist (never signs an arbitrary key)', async () => {
    db.asset = undefined; // owner ok, but the asset is missing
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
    // No taskId exists yet, so it never touches DynamoDB.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('requires an authenticated caller', async () => {
    await expect(
      handler(event('createTaskCoverImageUploadUrl', { input: { contentType: 'image/png' } }, null)),
    ).rejects.toThrow('authenticated user is required');
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

describe('media handler — deleteMediaAsset (owner or delegated SupportPerson)', () => {
  const asset = { PK: 'TASK#t1', SK: 'MEDIA#a1', entityType: 'MediaAsset', assetId: 'a1', taskId: 't1', s3Key: 'media/t1/a1.png', type: 'IMAGE', ownerId: 'o1' };

  // The cleanup mechanics (ref clearing, row + S3 delete, partial-failure logging) are
  // unit-tested against the shared service in src/shared/media.test.ts. Here we verify the
  // handler looks the asset up and delegates to that service, then returns it cleanly.
  it('looks the asset up and delegates to purgeMediaAsset, returning it without internal fields', async () => {
    db.asset = { ...asset };
    const result = (await handler(
      event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }),
    )) as MediaAsset;

    // Looked up by its PK/SK (after the ownership read).
    expect(assetGet()?.Key).toEqual({ PK: 'TASK#t1', SK: 'MEDIA#a1' });
    // Delegated to the shared purge service with the looked-up asset.
    expect(mockPurge).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', assetId: 'a1', s3Key: 'media/t1/a1.png' }),
      expect.objectContaining({ event: 'deleteMediaAsset' }),
    );
    // Returned metadata is stripped of storage attributes.
    const out = result as unknown as Record<string, unknown>;
    expect(out.PK).toBeUndefined();
    expect(out.SK).toBeUndefined();
    expect(out.entityType).toBeUndefined();
    expect(result.assetId).toBe('a1');
  });

  it('rejects a caller who cannot manage the task', async () => {
    mockAssertCanAct.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    db.asset = { ...asset };
    await expect(
      handler(event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }, 'intruder')),
    ).rejects.toThrow('no active support link');
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('lets a delegated SupportPerson delete media on a primary user’s task', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'pu-1' };
    db.asset = { ...asset, ownerId: 'pu-1' };
    const result = (await handler(
      event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } }, 'sup-1'),
    )) as MediaAsset;
    expect(mockAssertCanAct).toHaveBeenCalledWith(expect.objectContaining({ sub: 'sup-1' }), 'pu-1');
    expect(result.assetId).toBe('a1');
    expect(mockPurge).toHaveBeenCalled();
  });

  it('surfaces a retryable error when the durable S3 cleanup is still pending', async () => {
    db.asset = { ...asset };
    mockPurge.mockResolvedValueOnce(false);
    await expect(
      handler(event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'a1' } })),
    ).rejects.toThrow('could not be deleted; retry');
  });

  it('returns NotFound and purges nothing when the asset does not exist', async () => {
    db.asset = undefined; // owner ok, asset missing
    await expect(
      handler(event('deleteMediaAsset', { input: { taskId: 't1', assetId: 'gone' } })),
    ).rejects.toThrow('media asset not found');
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('validates taskId and assetId', async () => {
    await expect(handler(event('deleteMediaAsset', { input: { assetId: 'a1' } }))).rejects.toThrow('taskId is required');
    await expect(handler(event('deleteMediaAsset', { input: { taskId: 't1' } }))).rejects.toThrow('assetId is required');
  });
});
