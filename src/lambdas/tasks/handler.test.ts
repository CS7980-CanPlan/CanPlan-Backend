import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import {
  deleteS3ObjectBestEffort,
  prepareCoverImageAsset,
  purgeMediaAsset,
  retryTaskMediaCleanup,
} from '../../shared/media';
import type { Connection, Task, TaskStep } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

jest.mock('../../shared/media', () => ({
  prepareCoverImageAsset: jest.fn(),
  deleteS3ObjectBestEffort: jest.fn().mockResolvedValue(true),
  purgeMediaAsset: jest.fn().mockResolvedValue(true),
  retryTaskMediaCleanup: jest.fn().mockResolvedValue(true),
}));

const mockSend = dynamo.send as jest.Mock;
const mockPrepare = prepareCoverImageAsset as jest.Mock;
const mockDeleteS3 = deleteS3ObjectBestEffort as jest.Mock;
const mockPurge = purgeMediaAsset as jest.Mock;
const mockRetryMediaCleanup = retryTaskMediaCleanup as jest.Mock;

const OWNER = 'o1';

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

/** Identity defaults to the task owner (OWNER); pass another sub to test cross-owner denial. */
function event(fieldName: string, args: Record<string, unknown>, sub: string | null = OWNER) {
  return { arguments: args, info: { fieldName }, identity: sub ? { sub } : undefined } as Parameters<
    typeof handler
  >[0];
}

const calls = () => mockSend.mock.calls.map((c) => c[0]);
const lastInput = () => mockSend.mock.calls[0][0].input;
/** A task #META row owned by OWNER. */
const meta = (extra: Record<string, unknown> = {}) => ({
  PK: 'TASK#t1',
  SK: '#META',
  entityType: 'Task',
  taskId: 't1',
  ownerId: OWNER,
  title: 'T',
  categoryId: 'cat-1',
  taskCategoryKey: `${OWNER}#cat-1`,
  // Step metadata (concurrency-safe append bookkeeping); override per test.
  stepCount: 0,
  stepVersion: 1,
  nextStepOrder: 1,
  createdAt: 'c',
  ...extra,
});

describe('tasks handler — reads + authorization', () => {
  it('getTask reads #META and returns null when absent', async () => {
    const result = await handler(event('getTask', { taskId: 't1' }));
    expect(lastInput().Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(result).toBeNull();
  });

  it('getTask returns the task to its owner but rejects a non-owner', async () => {
    mockSend.mockResolvedValue({ Item: meta() });
    const result = (await handler(event('getTask', { taskId: 't1' }, OWNER))) as Task;
    expect(result.taskId).toBe('t1');
    await expect(handler(event('getTask', { taskId: 't1' }, 'intruder'))).rejects.toThrow(
      'does not own this resource',
    );
  });

  it('listTaskSteps sorts by numeric order and strips internal fields', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: meta() });
      if (cmd.constructor.name === 'QueryCommand') {
        if (cmd.input.ExpressionAttributeValues?.[':prefix'] === 'MEDIA#') {
          return Promise.resolve({
            Items: [
              { assetId: 'image-a', taskId: 't1', stepId: 'a', type: 'IMAGE', s3Key: 'media/t1/a.png' },
              { assetId: 'audio-a', taskId: 't1', stepId: 'a', type: 'AUDIO', s3Key: 'media/t1/a.mp3' },
            ],
          });
        }
        return Promise.resolve({
          Items: [
            { stepId: 'c', order: 3, taskId: 't1', PK: 'TASK#t1', SK: 'STEP#c', entityType: 'TaskStep' },
            { stepId: 'a', order: 1, taskId: 't1', PK: 'TASK#t1', SK: 'STEP#a', entityType: 'TaskStep' },
            { stepId: 'b', order: 2, taskId: 't1', PK: 'TASK#t1', SK: 'STEP#b', entityType: 'TaskStep' },
          ],
        });
      }
      return Promise.resolve({});
    });
    const result = (await handler(event('listTaskSteps', { taskId: 't1' }))) as Connection<TaskStep>;
    expect(result.items.map((s) => s.order)).toEqual([1, 2, 3]);
    const item = result.items[0] as unknown as Record<string, unknown>;
    expect(item.PK).toBeUndefined();
    expect(item.entityType).toBeUndefined();
    expect(result.items[0].mediaAssets?.map((asset) => asset.assetId)).toEqual(['image-a', 'audio-a']);
  });

  it('listTaskSteps preserves numeric order ACROSS pages (lexical stepId order differs)', async () => {
    // Lexical order zzz>aaa>mmm; numeric order is 1,2,3.
    const steps = [
      { stepId: 'zzz', order: 1, taskId: 't1' },
      { stepId: 'aaa', order: 2, taskId: 't1' },
      { stepId: 'mmm', order: 3, taskId: 't1' },
    ];
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: meta() });
      if (cmd.constructor.name === 'QueryCommand') return Promise.resolve({ Items: steps });
      return Promise.resolve({});
    });

    const page1 = (await handler(event('listTaskSteps', { taskId: 't1', limit: 2 }))) as Connection<TaskStep>;
    expect(page1.items.map((s) => s.stepId)).toEqual(['zzz', 'aaa']);
    expect(page1.items.map((s) => s.order)).toEqual([1, 2]);
    expect(page1.nextToken).not.toBeNull();

    const page2 = (await handler(
      event('listTaskSteps', { taskId: 't1', limit: 2, nextToken: page1.nextToken! }),
    )) as Connection<TaskStep>;
    expect(page2.items.map((s) => s.stepId)).toEqual(['mmm']);
    expect(page2.items.map((s) => s.order)).toEqual([3]);
    expect(page2.nextToken).toBeNull();
  });

  it('listTaskSteps rejects a non-owner and a missing task', async () => {
    mockSend.mockResolvedValue({ Item: meta() });
    await expect(handler(event('listTaskSteps', { taskId: 't1' }, 'intruder'))).rejects.toThrow(
      'does not own this resource',
    );
    mockSend.mockResolvedValue({}); // task missing
    await expect(handler(event('listTaskSteps', { taskId: 'gone' }))).rejects.toThrow('task gone not found');
  });

  it('listTasksByOwner requires the caller to be the owner', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: OWNER }] });
    await handler(event('listTasksByOwner', { ownerId: OWNER }));
    expect(lastInput().IndexName).toBe('taskOwnerIndex');
    await expect(handler(event('listTasksByOwner', { ownerId: 'someone-else' }, OWNER))).rejects.toThrow(
      'does not own this resource',
    );
  });

  it('listTasksByCategory validates the category (owned + existing) then queries the index', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { categoryId: 'cat-9', ownerId: OWNER, isDefault: false } }) // category validate
      .mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: OWNER }] }); // query
    const result = (await handler(
      event('listTasksByCategory', { ownerId: OWNER, categoryId: 'cat-9' }),
    )) as Connection<unknown>;
    expect(result.items).toHaveLength(1);
    const query = calls().find((c) => c.input.IndexName === 'taskCategoryIndex')!.input;
    expect(query.ExpressionAttributeValues).toEqual({ ':key': `${OWNER}#cat-9` });
  });

  it('listTasksByCategory requires a categoryId and rejects an unknown one', async () => {
    await expect(handler(event('listTasksByCategory', { ownerId: OWNER }))).rejects.toThrow(
      'categoryId is required',
    );
    mockSend.mockResolvedValueOnce({}); // category GET → none
    await expect(
      handler(event('listTasksByCategory', { ownerId: OWNER, categoryId: 'nope' })),
    ).rejects.toThrow('category nope not found');
  });

  it('listTasksByCategory rejects a non-owner before any read', async () => {
    await expect(
      handler(event('listTasksByCategory', { ownerId: 'someone-else', categoryId: 'c' }, OWNER)),
    ).rejects.toThrow('does not own this resource');
  });
});

describe('tasks handler — updateTask', () => {
  const existingTask = meta({
    title: 'Old title',
    description: 'old desc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  /** GET #META (loadOwnedTask) then the write. */
  const withExisting = () => mockSend.mockResolvedValueOnce({ Item: { ...existingTask } });
  const putInput = () => mockSend.mock.calls[1][0].input;

  it('reads #META, writes the merged item guarded on existence + current category, no status', async () => {
    withExisting();
    const result = (await handler(
      event('updateTask', { input: { taskId: 't1', title: 'New title', description: 'new' } }),
    )) as Task;
    expect(putInput().ConditionExpression).toBe('attribute_exists(PK) AND categoryId = :expectedCategory');
    expect(putInput().ExpressionAttributeValues[':expectedCategory']).toBe('cat-1');
    expect(putInput().Item.title).toBe('New title');
    expect(putInput().Item.status).toBeUndefined();
    expect(result.title).toBe('New title');
  });

  it('rejects a non-owner caller', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...existingTask } });
    await expect(
      handler(event('updateTask', { input: { taskId: 't1', title: 'x' } }, 'intruder')),
    ).rejects.toThrow('does not own this resource');
  });

  it('moves the task between categories, adjusting both counts in one transaction', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...existingTask } }) // GET #META
      .mockResolvedValueOnce({ Item: { categoryId: 'cat-9', ownerId: OWNER, isDefault: false } }) // validate new
      .mockResolvedValueOnce({}); // TransactWrite

    await handler(event('updateTask', { input: { taskId: 't1', categoryId: 'cat-9' } }));

    const tx = calls().find((c) => c.input.TransactItems)!.input;
    const put = tx.TransactItems.find((t: { Put?: unknown }) => t.Put).Put;
    expect(put.Item.categoryId).toBe('cat-9');
    expect(put.Item.taskCategoryKey).toBe(`${OWNER}#cat-9`);
    const dec = tx.TransactItems.find(
      (t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === 'CATEGORY#cat-1',
    );
    const inc = tx.TransactItems.find(
      (t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === 'CATEGORY#cat-9',
    );
    expect(dec.Update.ExpressionAttributeValues[':delta']).toBe(-1);
    expect(inc.Update.ExpressionAttributeValues[':delta']).toBe(1);
    expect(inc.Update.ConditionExpression).toContain('attribute_not_exists(deleting)');
  });

  it('does not touch counts when the supplied categoryId equals the current one', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...existingTask } }) // GET #META
      .mockResolvedValueOnce({ Item: { categoryId: 'cat-1', ownerId: OWNER, isDefault: false } }); // validate (same)
    await handler(event('updateTask', { input: { taskId: 't1', categoryId: 'cat-1' } }));
    // No transaction — a plain Put, since the category did not change.
    expect(calls().some((c) => c.input.TransactItems)).toBe(false);
  });

  it('rejects a blank categoryId and a missing/deleting category', async () => {
    await expect(
      handler(event('updateTask', { input: { taskId: 't1', categoryId: '   ' } })),
    ).rejects.toThrow('categoryId cannot be blank');
    expect(mockSend).not.toHaveBeenCalled();

    mockSend.mockResolvedValueOnce({ Item: { ...existingTask } }).mockResolvedValueOnce({}); // validate → none
    await expect(
      handler(event('updateTask', { input: { taskId: 't1', categoryId: 'nope' } })),
    ).rejects.toThrow('category nope not found');
  });

  it('throws NotFound and validates blank title before reading', async () => {
    await expect(
      handler(event('updateTask', { input: { taskId: 'missing', title: 'x' } })),
    ).rejects.toThrow('task missing not found');
    await expect(
      handler(event('updateTask', { input: { taskId: 't1', title: '   ' } })),
    ).rejects.toThrow('title cannot be empty');
  });

  describe('cover image replacement', () => {
    const newCover = {
      assetId: 'new-1',
      taskId: 't1',
      s3Key: 'media/t1/new-1.png',
      type: 'IMAGE',
      mimeType: 'image/png',
      ownerId: OWNER,
      createdAt: 'now',
      updatedAt: 'now',
    };

    it('promotes the new image, writes it atomically, then removes the old cover', async () => {
      mockPrepare.mockResolvedValueOnce({ ...newCover });
      mockSend
        .mockResolvedValueOnce({ Item: meta({ coverImageAssetId: 'old-1' }) }) // GET #META
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({ Item: { s3Key: 'media/t1/old-1.png' } }) // GET old asset
        .mockResolvedValueOnce({}); // delete old asset row

      const result = (await handler(
        event('updateTask', { input: { taskId: 't1', coverImageS3Key: 'media/pending/task-cover/u.png' } }),
      )) as Task;

      const tx = calls().find((c) => c.input.TransactItems)!.input;
      const items = tx.TransactItems.filter((t: { Put?: unknown }) => t.Put).map(
        (t: { Put: { Item: Record<string, unknown> } }) => t.Put.Item,
      );
      expect(items.find((i: Record<string, unknown>) => i.SK === '#META').coverImageAssetId).toBe('new-1');
      expect(items.find((i: Record<string, unknown>) => i.entityType === 'MediaAsset').SK).toBe('MEDIA#new-1');
      expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/old-1.png', expect.objectContaining({ oldAssetId: 'old-1' }));
      expect(result.coverImageAssetId).toBe('new-1');
    });

    it('best-effort removes the new S3 object and rethrows if the transaction fails', async () => {
      mockPrepare.mockResolvedValueOnce({ ...newCover });
      mockSend
        .mockResolvedValueOnce({ Item: meta({ coverImageAssetId: 'old-1' }) })
        .mockRejectedValueOnce(new Error('transaction canceled'));
      await expect(
        handler(event('updateTask', { input: { taskId: 't1', coverImageS3Key: 'media/pending/task-cover/u.png' } })),
      ).rejects.toThrow('transaction canceled');
      expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/new-1.png', expect.objectContaining({ event: 'updateTask.coverRollback' }));
    });
  });
});

describe('tasks handler — createTaskStep', () => {
  /** GET #META (owned) carrying the given step metadata; every write → {}. */
  const stub = (
    metaExtra: Record<string, unknown>,
    assets: Record<string, Record<string, unknown>> = {},
  ) => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: { SK?: string } } }) => {
      if (cmd.constructor.name === 'GetCommand') {
        const sk = cmd.input.Key?.SK ?? '';
        if (sk.startsWith('MEDIA#')) return Promise.resolve(assets[sk] ? { Item: assets[sk] } : {});
        return Promise.resolve({ Item: meta(metaExtra) });
      }
      return Promise.resolve({});
    });
  };
  const tx = () => calls().find((c) => c.input.TransactItems)?.input;
  const txMetaUpdate = () =>
    tx()?.TransactItems.find((t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === '#META')?.Update;
  const txStepPut = () =>
    tx()?.TransactItems.find((t: { Put?: { Item?: { entityType?: string } } }) => t.Put?.Item?.entityType === 'TaskStep')?.Put;

  it('appends at nextStepOrder in one versioned transaction (count++, version++, nextOrder++)', async () => {
    stub({ stepCount: 2, nextStepOrder: 3, stepVersion: 7 });
    const result = (await handler(
      event('createTaskStep', { input: { taskId: 't1', order: 3, text: 'Rinse', description: '  why  ' } }),
    )) as TaskStep;

    const metaUpd = txMetaUpdate();
    expect(metaUpd.UpdateExpression).toContain('stepCount = stepCount + :one');
    expect(metaUpd.UpdateExpression).toContain('stepVersion = stepVersion + :one');
    expect(metaUpd.UpdateExpression).toContain('nextStepOrder = nextStepOrder + :one');
    expect(metaUpd.ConditionExpression).toContain('stepVersion = :expectedVersion');
    expect(metaUpd.ConditionExpression).toContain('stepCount < :max');
    expect(metaUpd.ExpressionAttributeValues[':expectedVersion']).toBe(7);
    expect(metaUpd.ExpressionAttributeValues[':max']).toBe(99);

    const stepPut = txStepPut();
    expect(stepPut.Item.SK).toBe(`STEP#${result.stepId}`);
    expect(stepPut.Item.order).toBe(3);
    expect(stepPut.Item.text).toBe('Rinse');
    expect(stepPut.Item.description).toBe('why');
    expect(result.order).toBe(3);
  });

  it('attaches initial IMAGE/AUDIO/VIDEO assets atomically when creating a standalone step', async () => {
    stub(
      { stepCount: 0, nextStepOrder: 1, stepVersion: 1 },
      {
        'MEDIA#image': { assetId: 'image', taskId: 't1', type: 'IMAGE', s3Key: 'media/t1/i.png' },
        'MEDIA#audio': { assetId: 'audio', taskId: 't1', type: 'AUDIO', s3Key: 'media/t1/a.mp3' },
        'MEDIA#video': { assetId: 'video', taskId: 't1', type: 'VIDEO', s3Key: 'media/t1/v.mp4' },
      },
    );
    const result = (await handler(
      event('createTaskStep', {
        input: {
          taskId: 't1',
          order: 1,
          text: 'Watch and listen',
          media: [
            { type: 'VIDEO', assetId: 'video' },
            { type: 'AUDIO', assetId: 'audio' },
            { type: 'IMAGE', assetId: 'image' },
          ],
        },
      }),
    )) as TaskStep;
    const items = tx()!.TransactItems;
    expect(items.filter((item: { Update?: { Key?: { SK?: string } } }) => item.Update?.Key?.SK?.startsWith('MEDIA#'))).toHaveLength(3);
    expect(result.mediaAssets?.map((asset) => asset.type)).toEqual(['IMAGE', 'AUDIO', 'VIDEO']);
  });

  it('rejects an order that is not the next append position (use reorder to insert)', async () => {
    stub({ stepCount: 2, nextStepOrder: 3 });
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 2, text: 'x' } })),
    ).rejects.toThrow('order must be 3 (the next available position)');
    expect(tx()).toBeUndefined();
  });

  it('enforces the 99-step cap before writing', async () => {
    stub({ stepCount: 99, nextStepOrder: 100 });
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 100, text: 'x' } })),
    ).rejects.toThrow('at most 99 steps');
    expect(tx()).toBeUndefined();
  });

  it('rejects a legacy task with no step metadata (migration required)', async () => {
    mockSend.mockResolvedValue({
      Item: { taskId: 't1', ownerId: OWNER, categoryId: 'cat-1' }, // no stepVersion/stepCount/nextStepOrder
    });
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 1, text: 'x' } })),
    ).rejects.toThrow('missing step metadata; run the step/category migration');
  });

  it('rejects a nonexistent task and an unauthorized caller (no orphan steps)', async () => {
    mockSend.mockResolvedValue({}); // #META missing
    await expect(
      handler(event('createTaskStep', { input: { taskId: 'gone', order: 1, text: 'x' } })),
    ).rejects.toThrow('task gone not found');

    stub({ ownerId: 'someone-else', stepCount: 0, nextStepOrder: 1 });
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 1, text: 'x' } }, OWNER)),
    ).rejects.toThrow('does not own this resource');
    expect(tx()).toBeUndefined();
  });

  it('returns a retryable conflict error when a concurrent append wins (transaction canceled)', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { TransactItems?: unknown } }) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: meta({ stepCount: 1, nextStepOrder: 2, stepVersion: 1 }) });
      if (cmd.input.TransactItems) {
        return Promise.reject(Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' }));
      }
      return Promise.resolve({});
    });
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 2, text: 'x' } })),
    ).rejects.toThrow('changed concurrently');
  });

  it('two concurrent appends from the same state: exactly one succeeds, the other conflicts', async () => {
    // Both reads see the same stepVersion (1). The first transaction commits; the second is
    // canceled by DynamoDB because the version no longer matches.
    let firstTransaction = true;
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { TransactItems?: unknown } }) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: meta({ stepCount: 0, nextStepOrder: 1, stepVersion: 1 }) });
      if (cmd.input.TransactItems) {
        if (firstTransaction) {
          firstTransaction = false;
          return Promise.resolve({});
        }
        return Promise.reject(Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' }));
      }
      return Promise.resolve({});
    });
    const results = await Promise.allSettled([
      handler(event('createTaskStep', { input: { taskId: 't1', order: 1, text: 'a' } })),
      handler(event('createTaskStep', { input: { taskId: 't1', order: 1, text: 'b' } })),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('validates text and a positive integer order before any IO', async () => {
    await expect(handler(event('createTaskStep', { input: { order: 1, text: 'x' } }))).rejects.toThrow('taskId is required');
    await expect(handler(event('createTaskStep', { input: { taskId: 't1', order: 1, text: '' } }))).rejects.toThrow('text is required');
    await expect(handler(event('createTaskStep', { input: { taskId: 't1', order: 0, text: 'x' } }))).rejects.toThrow('order is required');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('tasks handler — updateTaskStep', () => {
  const updateInput = () => calls().find((c) => c.constructor.name === 'UpdateCommand')?.input;
  const txItems = () => {
    const tx = calls().find((c) => c.input.TransactItems);
    return tx ? tx.input.TransactItems.map((t: { Update?: unknown; Put?: unknown }) => t.Update ?? t.Put) : [];
  };
  /** GET #META (owned) → GET STEP#<id> → MEDIA# query / asset lookups. */
  const stub = (
    steps: Array<Record<string, unknown>>,
    opts: { cover?: string; assets?: Record<string, Record<string, unknown>>; owner?: string } = {},
  ) => {
    const byId = new Map(steps.map((s) => [s.stepId as string, s]));
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: { SK?: string } } }) => {
      const { name } = cmd.constructor;
      if (name === 'QueryCommand') {
        const prefix = (cmd.input as { ExpressionAttributeValues?: Record<string, unknown> })
          .ExpressionAttributeValues?.[':prefix'];
        return Promise.resolve({
          Items: prefix === 'MEDIA#' ? Object.values(opts.assets ?? {}) : steps,
        });
      }
      if (name === 'GetCommand') {
        const sk = cmd.input.Key?.SK ?? '';
        if (sk === '#META') {
          return Promise.resolve({ Item: meta({ ownerId: opts.owner ?? OWNER, coverImageAssetId: opts.cover }) });
        }
        if (sk.startsWith('STEP#')) {
          const step = byId.get(sk.slice('STEP#'.length));
          return Promise.resolve(step ? { Item: step } : {});
        }
        if (sk.startsWith('MEDIA#')) {
          const item = opts.assets?.[sk];
          return Promise.resolve(item ? { Item: item } : {});
        }
      }
      return Promise.resolve({});
    });
  };

  it('updates text (trimmed) on the row located by its stable key', async () => {
    stub([{ stepId: 's1', order: 3, taskId: 't1', text: 'old' }]);
    const result = (await handler(
      event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: '  Rinse  ' } }),
    )) as TaskStep;
    expect(updateInput().Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#s1' });
    expect(updateInput().ExpressionAttributeValues[':text']).toBe('Rinse');
    expect(result.text).toBe('Rinse');
  });

  it('sets, then clears (null), the description', async () => {
    stub([{ stepId: 's1', order: 1, taskId: 't1', text: 'a' }]);
    const set = (await handler(
      event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', description: '  d  ' } }),
    )) as TaskStep;
    expect(set.description).toBe('d');

    jest.clearAllMocks();
    stub([{ stepId: 's1', order: 1, taskId: 't1', text: 'a', description: 'old' }]);
    const cleared = (await handler(
      event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', description: null } }),
    )) as TaskStep;
    expect(updateInput().UpdateExpression).toContain('REMOVE description');
    expect(cleared.description).toBeUndefined();
  });

  it('rejects whitespace-only description, empty text, and empty/no media updates (no IO)', async () => {
    await expect(
      handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', description: '   ' } })),
    ).rejects.toThrow('description cannot be empty');
    await expect(
      handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: '  ' } })),
    ).rejects.toThrow('text cannot be empty');
    await expect(
      handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1' } })),
    ).rejects.toThrow('at least one of text, description, or a non-empty media list');
    await expect(
      handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', media: [] } })),
    ).rejects.toThrow('media must be a non-empty list');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a non-owner', async () => {
    stub([{ stepId: 's1', order: 1, taskId: 't1' }], { owner: 'someone-else' });
    await expect(
      handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: 'x' } }, OWNER)),
    ).rejects.toThrow('does not own this resource');
  });

  it('returns NotFound when the step does not exist', async () => {
    stub([{ stepId: 'other', order: 1 }]);
    await expect(
      handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 'missing', text: 'x' } })),
    ).rejects.toThrow('step missing not found for task t1');
  });

  it('attaches an unattached IMAGE asset into its type-specific slot atomically', async () => {
    stub([{ stepId: 's1', order: 1, taskId: 't1' }], {
      assets: { 'MEDIA#m1': { assetId: 'm1', taskId: 't1', type: 'IMAGE', s3Key: 'k' } },
    });
    const result = (await handler(
      event('updateTaskStep', {
        input: { taskId: 't1', stepId: 's1', media: [{ type: 'IMAGE', assetId: 'm1' }] },
      }),
    )) as TaskStep;
    const items = txItems();
    expect(items.find((i: { Key: { SK: string } }) => i.Key.SK === 'MEDIA#m1').ConditionExpression).toContain(
      'attribute_not_exists(stepId)',
    );
    expect(result.mediaAssets?.map((asset) => asset.assetId)).toEqual(['m1']);
    expect(items.find((i: { Key: { SK: string } }) => i.Key.SK === 'STEP#s1').UpdateExpression).toContain(
      'mediaVersion',
    );
  });

  it('replaces only the same media type and preserves the other type slots', async () => {
    stub([{ stepId: 's1', order: 1, taskId: 't1' }], {
      assets: {
        'MEDIA#new': { assetId: 'new', taskId: 't1', type: 'IMAGE', s3Key: 'media/t1/new.png' },
        'MEDIA#old': { assetId: 'old', taskId: 't1', stepId: 's1', type: 'IMAGE', s3Key: 'media/t1/old.png' },
        'MEDIA#audio': { assetId: 'audio', taskId: 't1', stepId: 's1', type: 'AUDIO', s3Key: 'media/t1/a.mp3' },
      },
    });
    const result = (await handler(
      event('updateTaskStep', {
        input: { taskId: 't1', stepId: 's1', media: [{ type: 'IMAGE', assetId: 'new' }] },
      }),
    )) as TaskStep;
    expect(mockPurge).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'old' }),
      expect.objectContaining({ event: 'updateTaskStep.replaceOrRemoveMedia' }),
    );
    expect(result.mediaAssets?.map((asset) => asset.assetId)).toEqual(['new', 'audio']);
  });

  it('sets multiple media types in one call and removes only the named type with assetId:null', async () => {
    stub([{ stepId: 's1', order: 1, taskId: 't1' }], {
      assets: {
        'MEDIA#image': { assetId: 'image', taskId: 't1', type: 'IMAGE', s3Key: 'media/t1/i.png' },
        'MEDIA#audio': { assetId: 'audio', taskId: 't1', type: 'AUDIO', s3Key: 'media/t1/a.mp3' },
        'MEDIA#video': { assetId: 'video', taskId: 't1', type: 'VIDEO', s3Key: 'media/t1/v.mp4' },
      },
    });
    const result = (await handler(
      event('updateTaskStep', {
        input: {
          taskId: 't1',
          stepId: 's1',
          media: [
            { type: 'IMAGE', assetId: 'image' },
            { type: 'AUDIO', assetId: 'audio' },
            { type: 'VIDEO', assetId: 'video' },
          ],
        },
      }),
    )) as TaskStep;
    expect(result.mediaAssets?.map((asset) => asset.type)).toEqual(['IMAGE', 'AUDIO', 'VIDEO']);

    jest.clearAllMocks();
    stub([{ stepId: 's1', order: 1, taskId: 't1' }], {
      assets: {
        'MEDIA#image': { assetId: 'image', taskId: 't1', stepId: 's1', type: 'IMAGE', s3Key: 'media/t1/i.png' },
        'MEDIA#audio': { assetId: 'audio', taskId: 't1', stepId: 's1', type: 'AUDIO', s3Key: 'media/t1/a.mp3' },
      },
    });
    const removed = (await handler(
      event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', media: [{ type: 'IMAGE', assetId: null }] } }),
    )) as TaskStep;
    expect(mockPurge).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'image' }),
      expect.objectContaining({ event: 'updateTaskStep.replaceOrRemoveMedia' }),
    );
    expect(removed.mediaAssets?.map((asset) => asset.assetId)).toEqual(['audio']);
  });

  it('rejects duplicate media types, a mismatched asset type, and a media concurrency conflict', async () => {
    await expect(
      handler(event('updateTaskStep', {
        input: { taskId: 't1', stepId: 's1', media: [{ type: 'IMAGE' }, { type: 'IMAGE' }] },
      })),
    ).rejects.toThrow('appears more than once');

    stub([{ stepId: 's1', order: 1, taskId: 't1' }], {
      assets: { 'MEDIA#a1': { assetId: 'a1', taskId: 't1', type: 'AUDIO', s3Key: 'a.mp3' } },
    });
    await expect(
      handler(event('updateTaskStep', {
        input: { taskId: 't1', stepId: 's1', media: [{ type: 'IMAGE', assetId: 'a1' }] },
      })),
    ).rejects.toThrow('expected IMAGE');

    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: { SK?: string }; TransactItems?: unknown; ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (cmd.constructor.name === 'GetCommand') {
        const sk = cmd.input.Key?.SK ?? '';
        if (sk === '#META') return Promise.resolve({ Item: meta() });
        if (sk === 'STEP#s1') return Promise.resolve({ Item: { stepId: 's1', taskId: 't1', order: 1 } });
        if (sk === 'MEDIA#a1') return Promise.resolve({ Item: { assetId: 'a1', taskId: 't1', type: 'IMAGE' } });
      }
      if (cmd.constructor.name === 'QueryCommand') return Promise.resolve({ Items: [] });
      if (cmd.input.TransactItems) return Promise.reject(Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' }));
      return Promise.resolve({});
    });
    await expect(
      handler(event('updateTaskStep', {
        input: { taskId: 't1', stepId: 's1', media: [{ type: 'IMAGE', assetId: 'a1' }] },
      })),
    ).rejects.toThrow('media changed concurrently');
  });
});

describe('tasks handler — reorderTaskSteps', () => {
  const current = [
    { stepId: 's1', taskId: 't1', order: 1, text: 'a', description: 'd' },
    { stepId: 's2', taskId: 't1', order: 2, text: 'b' },
    { stepId: 's3', taskId: 't1', order: 3, text: 'c' },
  ];
  const stub = (
    steps: Array<Record<string, unknown>>,
    metaExtra: Record<string, unknown> = {},
    media: Array<Record<string, unknown>> = [],
  ) => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: meta(metaExtra) });
      if (cmd.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: cmd.input.ExpressionAttributeValues?.[':prefix'] === 'MEDIA#' ? media : steps,
        });
      }
      return Promise.resolve({});
    });
  };

  it('atomically renumbers every step + bumps stepVersion / resets nextStepOrder; preserves media+description', async () => {
    stub(current, { stepVersion: 4, stepCount: 3 }, [
      { assetId: 'm1', taskId: 't1', stepId: 's1', type: 'IMAGE', s3Key: 'media/t1/m1.png' },
    ]);
    const result = (await handler(
      event('reorderTaskSteps', {
        input: {
          taskId: 't1',
          steps: [
            { stepId: 's1', order: 3 },
            { stepId: 's2', order: 1 },
            { stepId: 's3', order: 2 },
          ],
        },
      }),
    )) as TaskStep[];

    const tx = calls().find((c) => c.input.TransactItems)!.input;
    const items = tx.TransactItems.map((t: { Update: Record<string, unknown> }) => t.Update);
    // 3 step updates + 1 metadata update.
    expect(items).toHaveLength(4);
    const stepUpdates = items.filter((u: { Key: { SK: string } }) => u.Key.SK.startsWith('STEP#'));
    expect(stepUpdates).toHaveLength(3);
    for (const u of stepUpdates) {
      expect(u.UpdateExpression as string).toBe('SET #order = :order, #updatedAt = :now');
    }
    const metaUpd = items.find((u: { Key: { SK: string } }) => u.Key.SK === '#META');
    expect(metaUpd.UpdateExpression).toContain('stepVersion = :newVersion');
    expect(metaUpd.UpdateExpression).toContain('nextStepOrder = :nextOrder');
    expect(metaUpd.ConditionExpression).toContain('stepVersion = :expectedVersion');
    expect(metaUpd.ExpressionAttributeValues[':expectedVersion']).toBe(4);
    expect(metaUpd.ExpressionAttributeValues[':newVersion']).toBe(5);
    expect(metaUpd.ExpressionAttributeValues[':nextOrder']).toBe(4); // N+1, orders now 1..3
    expect(metaUpd.ExpressionAttributeValues[':n']).toBe(3); // stepCount unchanged

    expect(result.map((s) => s.stepId)).toEqual(['s2', 's3', 's1']);
    expect(result.map((s) => s.order)).toEqual([1, 2, 3]);
    const moved = result.find((s) => s.stepId === 's1')!;
    expect(moved.mediaAssets?.map((asset) => asset.assetId)).toEqual(['m1']);
    expect(moved.description).toBe('d');
  });

  it('returns a retryable conflict error when steps changed concurrently (transaction canceled)', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { TransactItems?: unknown } }) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: meta({ stepVersion: 1, stepCount: 3 }) });
      if (cmd.constructor.name === 'QueryCommand') return Promise.resolve({ Items: current });
      if (cmd.input.TransactItems) {
        return Promise.reject(Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' }));
      }
      return Promise.resolve({});
    });
    await expect(
      handler(
        event('reorderTaskSteps', {
          input: { taskId: 't1', steps: [{ stepId: 's1', order: 1 }, { stepId: 's2', order: 2 }, { stepId: 's3', order: 3 }] },
        }),
      ),
    ).rejects.toThrow('changed concurrently');
  });

  it('rejects a non-owner', async () => {
    stub(current, { ownerId: 'someone-else' });
    await expect(
      handler(
        event('reorderTaskSteps', {
          input: { taskId: 't1', steps: [{ stepId: 's1', order: 1 }, { stepId: 's2', order: 2 }, { stepId: 's3', order: 3 }] },
        }, OWNER),
      ),
    ).rejects.toThrow('does not own this resource');
  });

  it('rejects a partial set, an unknown stepId, duplicates, and non-contiguous orders', async () => {
    stub(current);
    await expect(
      handler(event('reorderTaskSteps', { input: { taskId: 't1', steps: [{ stepId: 's1', order: 1 }] } })),
    ).rejects.toThrow("must include all of the task's 3 step(s)");
    await expect(
      handler(
        event('reorderTaskSteps', {
          input: { taskId: 't1', steps: [{ stepId: 's1', order: 1 }, { stepId: 's2', order: 2 }, { stepId: 'ghost', order: 3 }] },
        }),
      ),
    ).rejects.toThrow('step ghost not found for task t1');
    await expect(
      handler(event('reorderTaskSteps', { input: { taskId: 't1', steps: [{ stepId: 's1', order: 1 }, { stepId: 's1', order: 2 }] } })),
    ).rejects.toThrow('appears more than once');
    await expect(
      handler(event('reorderTaskSteps', { input: { taskId: 't1', steps: [{ stepId: 's1', order: 1 }, { stepId: 's2', order: 3 }] } })),
    ).rejects.toThrow('must be an integer between 1 and 2');
  });

  it('rejects an empty list and more than 99 steps before any IO', async () => {
    await expect(
      handler(event('reorderTaskSteps', { input: { taskId: 't1', steps: [] } })),
    ).rejects.toThrow('complete current step set');
    const many = Array.from({ length: 100 }, (_, i) => ({ stepId: `s${i}`, order: i + 1 }));
    await expect(
      handler(event('reorderTaskSteps', { input: { taskId: 't1', steps: many } })),
    ).rejects.toThrow('at most 99 steps');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('tasks handler — deleteTaskStep', () => {
  const standaloneStepDelete = () =>
    calls().find((c) => c.constructor.name === 'DeleteCommand' && c.input.Key?.SK?.startsWith('STEP#'))?.input;
  const finalTx = () => calls().find((c) => c.input.TransactItems)?.input;
  const txStepDelete = () =>
    finalTx()?.TransactItems.find((t: { Delete?: { Key?: { SK?: string } } }) => t.Delete?.Key?.SK?.startsWith('STEP#'))?.Delete;
  const txMetaUpdate = () =>
    finalTx()?.TransactItems.find((t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === '#META')?.Update;
  const stub = (opts: {
    steps: Array<Record<string, unknown>>;
    media?: Array<Record<string, unknown>>;
    metaExtra?: Record<string, unknown>;
  }) => {
    const byId = new Map(opts.steps.map((s) => [s.stepId as string, s]));
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: { SK?: string } } }) => {
      const { name } = cmd.constructor;
      if (name === 'GetCommand') {
        const sk = cmd.input.Key?.SK ?? '';
        if (sk === '#META') return Promise.resolve({ Item: meta({ stepCount: 1, ...opts.metaExtra }) });
        if (sk.startsWith('STEP#')) {
          const step = byId.get(sk.slice('STEP#'.length));
          return Promise.resolve(step ? { Item: step } : {});
        }
      }
      if (name === 'QueryCommand') {
        return Promise.resolve({ Items: opts.media ?? [] });
      }
      return Promise.resolve({});
    });
  };

  it('deletes the step row + decrements stepCount / bumps stepVersion in one transaction', async () => {
    stub({ steps: [{ stepId: 's1', taskId: 't1', order: 1, text: 'a', entityType: 'TaskStep' }] });
    const result = (await handler(
      event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }),
    )) as TaskStep;
    expect(txStepDelete().Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#s1' });
    expect(txMetaUpdate().UpdateExpression).toContain('stepCount = stepCount - :one');
    expect(txMetaUpdate().UpdateExpression).toContain('stepVersion');
    expect(txMetaUpdate().ConditionExpression).toContain('stepCount > :zero');
    expect(mockPurge).not.toHaveBeenCalled();
    expect(result.stepId).toBe('s1');
  });

  it('falls back to a plain delete (no metadata update) for a legacy task without stepCount', async () => {
    stub({
      steps: [{ stepId: 's1', taskId: 't1', order: 1, text: 'a' }],
      // Legacy task: meta without stepCount/stepVersion/nextStepOrder.
      metaExtra: { stepCount: undefined, stepVersion: undefined, nextStepOrder: undefined },
    });
    await handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }));
    expect(standaloneStepDelete().Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#s1' });
    expect(finalTx()).toBeUndefined();
  });

  it('rejects a non-owner', async () => {
    stub({ steps: [{ stepId: 's1', order: 1 }], metaExtra: { ownerId: 'someone-else' } });
    await expect(
      handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }, OWNER)),
    ).rejects.toThrow('does not own this resource');
  });

  it('returns NotFound when the step does not exist', async () => {
    stub({ steps: [] });
    await expect(
      handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 'missing' } })),
    ).rejects.toThrow('step missing not found for task t1');
  });

  it('deletes the step and purges every attached media asset', async () => {
    stub({
      steps: [{ stepId: 's1', taskId: 't1', order: 1 }],
      media: [
        { assetId: 'image', taskId: 't1', stepId: 's1', type: 'IMAGE', s3Key: 'media/t1/i.png' },
        { assetId: 'audio', taskId: 't1', stepId: 's1', type: 'AUDIO', s3Key: 'media/t1/a.mp3' },
      ],
    });
    await handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }));
    expect(mockPurge).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'image' }),
      expect.objectContaining({ event: 'deleteTaskStep', taskId: 't1', stepId: 's1' }),
    );
    expect(mockPurge).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'audio' }),
      expect.objectContaining({ event: 'deleteTaskStep', taskId: 't1', stepId: 's1' }),
    );
  });

  it('surfaces a retryable error when the S3 cleanup fails (step left in place)', async () => {
    mockPurge.mockResolvedValueOnce(false);
    stub({
      steps: [{ stepId: 's1', taskId: 't1', order: 1 }],
      media: [{ assetId: 'm1', taskId: 't1', stepId: 's1', type: 'IMAGE', s3Key: 'media/t1/m1.png' }],
    });
    await expect(
      handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } })),
    ).rejects.toThrow('could not be deleted; retry');
    expect(finalTx()).toBeUndefined();
    expect(standaloneStepDelete()).toBeUndefined();
    expect(mockRetryMediaCleanup).toHaveBeenCalled();
  });
});

describe('tasks handler — deleteTask', () => {
  const m = meta({ taskCategoryKey: `${OWNER}#cat-1` });
  const inputs = () => mockSend.mock.calls.map((c) => c[0].input);
  const batchInputs = () => inputs().filter((i) => i.RequestItems);
  const putBatches = () => batchInputs().filter((i) => i.RequestItems['CanPlan-test'][0]?.PutRequest);
  const deleteBatches = () => batchInputs().filter((i) => i.RequestItems['CanPlan-test'][0]?.DeleteRequest);
  const finalTx = () => inputs().find((i) => i.TransactItems);

  it('deletes #META + decrements its category, plus all steps, media, and S3 objects', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...m } }) // loadOwnedTask GET #META
      .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#s1' }, { PK: 'TASK#t1', SK: 'STEP#s2' }] }) // STEP# keys
      .mockResolvedValueOnce({
        Items: [
          { PK: 'TASK#t1', SK: 'MEDIA#cover', assetId: 'cover', s3Key: 'media/t1/cover.png' },
          { PK: 'TASK#t1', SK: 'MEDIA#m2', assetId: 'm2', s3Key: 'media/t1/m2.jpg' },
        ],
      }) // MEDIA# items
      .mockResolvedValueOnce({}) // journal batchPut
      .mockResolvedValueOnce({}) // children batchDelete
      .mockResolvedValueOnce({
        Items: [
          { PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#cover', assetId: 'cover', s3Key: 'media/t1/cover.png' },
          { PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#m2', assetId: 'm2', s3Key: 'media/t1/m2.jpg' },
        ],
      }) // cleanup query
      .mockResolvedValueOnce({}) // cleanup batchDelete
      .mockResolvedValueOnce({}); // final TransactWrite (#META delete + category -1)

    const result = (await handler(event('deleteTask', { taskId: 't1' }))) as Task;

    expect(putBatches()).toHaveLength(1);
    expect(deleteBatches()[0].RequestItems['CanPlan-test']).toHaveLength(4);
    // Final transaction deletes #META and decrements the task's category count.
    const tx = finalTx()!;
    expect(tx.TransactItems[0].Delete.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(tx.TransactItems[0].Delete.ConditionExpression).toContain('categoryId = :cat');
    expect(tx.TransactItems[1].Update.Key.SK).toBe('CATEGORY#cat-1');
    expect(tx.TransactItems[1].Update.ExpressionAttributeValues[':delta']).toBe(-1);
    expect(mockDeleteS3).toHaveBeenCalledTimes(2);
    expect(result.taskId).toBe('t1');
    expect((result as unknown as Record<string, unknown>).taskCategoryKey).toBeUndefined();
  });

  it('returns NotFound and writes nothing when the task does not exist', async () => {
    await expect(handler(event('deleteTask', { taskId: 'missing' }))).rejects.toThrow('task missing not found');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDeleteS3).not.toHaveBeenCalled();
  });

  it('rejects a non-owner', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...m } });
    await expect(handler(event('deleteTask', { taskId: 't1' }, 'intruder'))).rejects.toThrow(
      'does not own this resource',
    );
  });

  it('keeps the task + journal retryable when an S3 delete fails (no #META delete)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...m } })
      .mockResolvedValueOnce({ Items: [] }) // STEP#
      .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }] }) // MEDIA#
      .mockResolvedValueOnce({}) // journal
      .mockResolvedValueOnce({}) // children delete
      .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }] }); // cleanup query
    mockDeleteS3.mockResolvedValueOnce(false);
    await expect(handler(event('deleteTask', { taskId: 't1' }))).rejects.toThrow('could not be deleted');
    expect(finalTx()).toBeUndefined(); // #META never deleted
  });
});

describe('tasks handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
