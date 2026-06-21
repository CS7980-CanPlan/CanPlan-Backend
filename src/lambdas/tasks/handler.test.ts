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

// Cover-image S3 work + the shared media-cleanup service are unit-tested in
// shared/media.test.ts; stub them here so the tasks handler tests focus on DB
// orchestration, reference decisions, and cleanup ordering.
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

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

function event(fieldName: string, args: Record<string, unknown>) {
  return { arguments: args, info: { fieldName } } as Parameters<typeof handler>[0];
}

const lastInput = () => mockSend.mock.calls[0][0].input;

describe('tasks handler', () => {
  it('getTask reads PK=TASK#<id>, SK=#META and returns null when absent', async () => {
    const result = await handler(event('getTask', { taskId: 't1' }));
    expect(lastInput().Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(result).toBeNull();
  });

  it('listTaskSteps queries PK=TASK#<id> with SK begins_with STEP#', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ stepId: 's1', order: 1 }] });
    const result = (await handler(event('listTaskSteps', { taskId: 't1' }))) as Connection<unknown>;
    expect(lastInput().KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':pk': 'TASK#t1', ':prefix': 'STEP#' });
    expect(result.items).toHaveLength(1);
  });

  it('listTasksByOwner queries taskOwnerIndex and filters to entityType=Task', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: 'o1' }] });
    await handler(event('listTasksByOwner', { ownerId: 'o1' }));
    expect(lastInput().IndexName).toBe('taskOwnerIndex');
    expect(lastInput().FilterExpression).toBe('entityType = :task');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':owner': 'o1', ':task': 'Task' });
  });

  it('listTasksByCategory queries taskCategoryIndex with <ownerId>#<categoryId>', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: 'o1' }] });
    const result = (await handler(
      event('listTasksByCategory', { ownerId: 'o1', categoryId: 'cat-9' }),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('taskCategoryIndex');
    expect(lastInput().KeyConditionExpression).toBe('taskCategoryKey = :key');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':key': 'o1#cat-9' });
    // Sparse index — no entityType filter needed.
    expect(lastInput().FilterExpression).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });

  it('listTasksByCategory falls back to NO_CATEGORY when categoryId is omitted or blank', async () => {
    await handler(event('listTasksByCategory', { ownerId: 'o1' }));
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':key': 'o1#NO_CATEGORY' });
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    await handler(event('listTasksByCategory', { ownerId: 'o1', categoryId: '   ' }));
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':key': 'o1#NO_CATEGORY' });
  });

  it('listTasksByCategory requires an ownerId', async () => {
    await expect(handler(event('listTasksByCategory', { categoryId: 'c1' }))).rejects.toThrow(
      'ownerId is required',
    );
  });

  describe('updateTask', () => {
    const existingTask = {
      PK: 'TASK#t1',
      SK: '#META',
      entityType: 'Task',
      taskId: 't1',
      ownerId: 'o1',
      title: 'Old title',
      categoryId: 'cat-1',
      taskCategoryKey: 'o1#cat-1',
      description: 'old desc',
      status: 'DRAFT',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    /** Mock the read (GetCommand) with the existing task; the write falls back to {}. */
    function withExisting() {
      mockSend.mockResolvedValueOnce({ Item: { ...existingTask } });
    }
    const putInput = () => mockSend.mock.calls[1][0].input;

    it('reads the #META item then writes the merged item back, conditioned on existence', async () => {
      withExisting();
      const result = (await handler(
        event('updateTask', { input: { taskId: 't1', title: 'New title', status: 'ACTIVE' } }),
      )) as Task;

      // 1) read by the task's #META key.
      expect(mockSend.mock.calls[0][0].input.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
      // 2) write the merged item, guarded so it never resurrects a deleted task.
      expect(putInput().ConditionExpression).toBe('attribute_exists(PK)');
      expect(putInput().Item.title).toBe('New title');
      expect(putInput().Item.status).toBe('ACTIVE');
      // Untouched fields + key attributes carried over from the existing item.
      expect(putInput().Item.ownerId).toBe('o1');
      expect(putInput().Item.description).toBe('old desc');
      expect(putInput().Item.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(putInput().Item.PK).toBe('TASK#t1');
      expect(putInput().Item.SK).toBe('#META');
      expect(putInput().Item.entityType).toBe('Task');
      // updatedAt advances past createdAt.
      expect(putInput().Item.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
      expect(result.title).toBe('New title');
    });

    it('recomputes taskCategoryKey when categoryId changes', async () => {
      withExisting();
      await handler(event('updateTask', { input: { taskId: 't1', categoryId: 'cat-9' } }));
      expect(putInput().Item.categoryId).toBe('cat-9');
      expect(putInput().Item.taskCategoryKey).toBe('o1#cat-9');
    });

    it('defaults a blank categoryId to NO_CATEGORY and recomputes taskCategoryKey', async () => {
      withExisting();
      await handler(event('updateTask', { input: { taskId: 't1', categoryId: '  ' } }));
      expect(putInput().Item.categoryId).toBe('NO_CATEGORY');
      expect(putInput().Item.taskCategoryKey).toBe('o1#NO_CATEGORY');
    });

    it('stores a new schedule and re-derives nextOccurrenceAt', async () => {
      withExisting();
      await handler(
        event('updateTask', {
          input: {
            taskId: 't1',
            schedule: {
              repeatEvery: 3,
              repeatUnit: 'WEEK',
              firstOccurrenceAt: '2026-08-01T09:00:00Z',
              timezone: 'UTC',
            },
          },
        }),
      );
      expect(putInput().Item.schedule).toEqual({
        repeatEvery: 3,
        repeatUnit: 'WEEK',
        firstOccurrenceAt: '2026-08-01T09:00:00Z',
        timezone: 'UTC',
        enabled: true,
      });
      expect(putInput().Item.nextOccurrenceAt).toBe('2026-08-01T09:00:00Z');
    });

    it('leaves untouched fields alone when only one field changes', async () => {
      withExisting();
      await handler(event('updateTask', { input: { taskId: 't1', description: 'new desc' } }));
      expect(putInput().Item.description).toBe('new desc');
      expect(putInput().Item.title).toBe('Old title');
      expect(putInput().Item.categoryId).toBe('cat-1');
      expect(putInput().Item.taskCategoryKey).toBe('o1#cat-1');
    });

    it('throws NotFoundError and does not write when the task does not exist', async () => {
      // Default mock returns {} (no Item) for the read.
      await expect(
        handler(event('updateTask', { input: { taskId: 'missing', title: 'x' } })),
      ).rejects.toThrow('task missing not found');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('validates taskId and rejects a blank title before reading or writing', async () => {
      await expect(handler(event('updateTask', { input: { title: 'x' } }))).rejects.toThrow(
        'taskId is required',
      );
      await expect(
        handler(event('updateTask', { input: { taskId: 't1', title: '   ' } })),
      ).rejects.toThrow('title cannot be empty');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects an invalid schedule before reading', async () => {
      await expect(
        handler(
          event('updateTask', {
            input: {
              taskId: 't1',
              schedule: {
                repeatEvery: 0,
                repeatUnit: 'DAY',
                firstOccurrenceAt: '2026-08-01T09:00:00Z',
                timezone: 'UTC',
              },
            },
          }),
        ),
      ).rejects.toThrow('repeatEvery must be a positive integer');
      expect(mockSend).not.toHaveBeenCalled();
    });

    describe('cover image replacement', () => {
      const commands = () => mockSend.mock.calls.map((c) => c[0]);
      const newCover = {
        assetId: 'new-1',
        taskId: 't1',
        s3Key: 'media/t1/new-1.png',
        type: 'IMAGE',
        mimeType: 'image/png',
        ownerId: 'o1',
        size: 1234,
        createdAt: 'now',
        updatedAt: 'now',
      };
      const withCover = (extra: Record<string, unknown> = {}) => ({
        PK: 'TASK#t1',
        SK: '#META',
        entityType: 'Task',
        taskId: 't1',
        ownerId: 'o1',
        title: 'T',
        status: 'ACTIVE',
        createdAt: 'c',
        ...extra,
      });

      it('promotes the new image, writes it atomically, then removes the old cover after', async () => {
        mockPrepare.mockResolvedValueOnce({ ...newCover });
        mockSend
          .mockResolvedValueOnce({ Item: withCover({ coverImageAssetId: 'old-1' }) }) // GET existing
          .mockResolvedValueOnce({}) // TransactWrite (task + new MediaAsset)
          .mockResolvedValueOnce({ Item: { s3Key: 'media/t1/old-1.png' } }) // GET old asset
          .mockResolvedValueOnce({}); // Delete old asset row

        const result = (await handler(
          event('updateTask', { input: { taskId: 't1', coverImageS3Key: 'media/pending/task-cover/u.png' } }),
        )) as Task;

        // Atomic transaction carrying the updated task + the new MediaAsset row.
        const tx = commands().find((c) => c.input.TransactItems)!;
        const items = tx.input.TransactItems.map((t: { Put: { Item: Record<string, unknown> } }) => t.Put.Item);
        expect(items.find((i: Record<string, unknown>) => i.SK === '#META').coverImageAssetId).toBe('new-1');
        expect(items.find((i: Record<string, unknown>) => i.entityType === 'MediaAsset').SK).toBe('MEDIA#new-1');

        // The OLD cover is removed only AFTER the transaction (new asset created first).
        const txIndex = commands().findIndex((c) => c.input.TransactItems);
        const oldDeleteIndex = commands().findIndex(
          (c) => c.constructor.name === 'DeleteCommand' && c.input.Key.SK === 'MEDIA#old-1',
        );
        expect(oldDeleteIndex).toBeGreaterThan(txIndex);
        expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/old-1.png', expect.objectContaining({ oldAssetId: 'old-1' }));
        expect(result.coverImageAssetId).toBe('new-1');
      });

      it('skips old-cover cleanup when the task had no previous cover', async () => {
        mockPrepare.mockResolvedValueOnce({ ...newCover });
        mockSend
          .mockResolvedValueOnce({ Item: withCover() }) // no coverImageAssetId
          .mockResolvedValueOnce({}); // TransactWrite only

        const result = (await handler(
          event('updateTask', { input: { taskId: 't1', coverImageS3Key: 'media/pending/task-cover/u.png' } }),
        )) as Task;

        expect(result.coverImageAssetId).toBe('new-1');
        // No old-asset delete, no old-binary cleanup.
        expect(commands().some((c) => c.constructor.name === 'DeleteCommand')).toBe(false);
        expect(mockDeleteS3).not.toHaveBeenCalled();
      });

      it('does not roll back the new cover when old-cover cleanup fails; logs a retryable failure', async () => {
        mockPrepare.mockResolvedValueOnce({ ...newCover });
        mockSend
          .mockResolvedValueOnce({ Item: withCover({ coverImageAssetId: 'old-1' }) }) // GET existing
          .mockResolvedValueOnce({}) // TransactWrite (new cover now active)
          .mockResolvedValueOnce({ Item: { s3Key: 'media/t1/old-1.png' } }) // GET old asset
          .mockRejectedValueOnce(new Error('delete row failed')); // Delete old row FAILS
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        const result = (await handler(
          event('updateTask', { input: { taskId: 't1', coverImageS3Key: 'media/pending/task-cover/u.png' } }),
        )) as Task;

        // New cover stays active (no rollback), and the failure is logged with context.
        expect(result.coverImageAssetId).toBe('new-1');
        const logged = errSpy.mock.calls.map((c) => c[0] as string).join('\n');
        expect(logged).toContain('oldCoverCleanupFailed');
        expect(logged).toContain('old-1');
        errSpy.mockRestore();
      });

      it('best-effort removes the new S3 object and rethrows if the transaction fails', async () => {
        mockPrepare.mockResolvedValueOnce({ ...newCover });
        mockSend
          .mockResolvedValueOnce({ Item: withCover({ coverImageAssetId: 'old-1' }) }) // GET existing
          .mockRejectedValueOnce(new Error('transaction canceled')); // TransactWrite fails

        await expect(
          handler(event('updateTask', { input: { taskId: 't1', coverImageS3Key: 'media/pending/task-cover/u.png' } })),
        ).rejects.toThrow('transaction canceled');

        // New object rolled back; the OLD cover is left untouched (never reached).
        expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/new-1.png', expect.objectContaining({ event: 'updateTask.coverRollback' }));
        expect(mockDeleteS3).not.toHaveBeenCalledWith('media/t1/old-1.png', expect.anything());
      });

      it('returns NotFound (and never copies an image) when the task does not exist', async () => {
        // GET existing → {} (no Item). prepare must not run.
        await expect(
          handler(event('updateTask', { input: { taskId: 'gone', coverImageS3Key: 'media/pending/task-cover/u.png' } })),
        ).rejects.toThrow('task gone not found');
        expect(mockPrepare).not.toHaveBeenCalled();
      });
    });
  });

  describe('updateTaskStep', () => {
    const commands = () => mockSend.mock.calls.map((c) => c[0]);
    const updateInput = () => commands().find((c) => c.constructor.name === 'UpdateCommand')?.input;
    const txItems = () => {
      const tx = commands().find((c) => c.input.TransactItems);
      return tx ? tx.input.TransactItems.map((t: { Update?: unknown; Put?: unknown }) => t.Update ?? t.Put) : [];
    };
    /**
     * Leak-free stub: STEP# query → `steps`; GET #META → optional cover; GET MEDIA#<id> →
     * `assets[SK]` (or not-found); every write (Update/Transact) → {}.
     */
    const stub = (
      steps: Array<Record<string, unknown>>,
      opts: { cover?: string; assets?: Record<string, Record<string, unknown>> } = {},
    ) => {
      mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: { SK?: string } } }) => {
        const { name } = cmd.constructor;
        if (name === 'QueryCommand') return Promise.resolve({ Items: steps });
        if (name === 'GetCommand') {
          const sk = cmd.input.Key?.SK ?? '';
          if (sk === '#META') {
            return Promise.resolve({ Item: opts.cover ? { coverImageAssetId: opts.cover } : {} });
          }
          const item = opts.assets?.[sk];
          return Promise.resolve(item ? { Item: item } : {});
        }
        return Promise.resolve({});
      });
    };

    it('updates text (trimmed) on the row found by stepId, keyed by its order', async () => {
      stub([{ stepId: 's1', order: 3, taskId: 't1', text: 'old', createdAt: 'c' }]);
      const result = (await handler(
        event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: '  Rinse  ' } }),
      )) as TaskStep;

      const input = updateInput();
      // Keyed by the step's stored order, never reconstructed from stepId.
      expect(input.Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#003' });
      expect(input.UpdateExpression).toContain('#text = :text');
      expect(input.ExpressionAttributeValues[':text']).toBe('Rinse');
      expect(input.ConditionExpression).toBe('attribute_exists(PK)');
      const out = result as unknown as Record<string, unknown>;
      expect(out.PK).toBeUndefined();
      expect(out.SK).toBeUndefined();
      expect(out.entityType).toBeUndefined();
      expect(result.text).toBe('Rinse');
    });

    it('rejects an empty (whitespace) text before touching DynamoDB', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: '   ' } })),
      ).rejects.toThrow('text cannot be empty');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects a request with none of text / mediaAssetId / removeMedia', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1' } })),
      ).rejects.toThrow('at least one of text, mediaAssetId, or removeMedia: true');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects supplying both mediaAssetId and removeMedia: true', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'm1', removeMedia: true } })),
      ).rejects.toThrow('cannot provide both mediaAssetId and removeMedia');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns NotFound when no STEP# row has the given stepId', async () => {
      stub([{ stepId: 'other', order: 1 }]);
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 'missing', text: 'x' } })),
      ).rejects.toThrow('step missing not found for task t1');
      expect(commands().some((c) => c.constructor.name === 'UpdateCommand')).toBe(false);
    });

    it('validates taskId and stepId', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { stepId: 's1', text: 'x' } })),
      ).rejects.toThrow('taskId is required');
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', text: 'x' } })),
      ).rejects.toThrow('stepId is required');
    });

    describe('attach media (mediaAssetId)', () => {
      it('attaches an unattached asset: sets the asset stepId + the step mediaAssetId atomically', async () => {
        stub([{ stepId: 's1', order: 1 }], {
          assets: { 'MEDIA#m1': { assetId: 'm1', taskId: 't1', s3Key: 'media/t1/m1.png' } },
        });
        const result = (await handler(
          event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'm1' } }),
        )) as TaskStep;

        const items = txItems();
        const assetUpd = items.find((i: { Key: { SK: string } }) => i.Key.SK === 'MEDIA#m1');
        expect(assetUpd.UpdateExpression).toContain('stepId = :stepId');
        // Guarded so a concurrent attach can't double-bind the asset.
        expect(assetUpd.ConditionExpression).toContain('attribute_not_exists(stepId)');
        expect(assetUpd.ExpressionAttributeValues[':stepId']).toBe('s1');
        const stepUpd = items.find((i: { Key: { SK: string } }) => i.Key.SK === 'STEP#001');
        expect(stepUpd.ExpressionAttributeValues[':assetId']).toBe('m1');
        expect(result.mediaAssetId).toBe('m1');
        expect(mockPurge).not.toHaveBeenCalled(); // nothing replaced
      });

      it('rejects attaching an asset that belongs to another Task (absent under this task)', async () => {
        stub([{ stepId: 's1', order: 1 }], { assets: {} }); // GET MEDIA#other → not found
        await expect(
          handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'other' } })),
        ).rejects.toThrow('media asset other not found under task t1');
      });

      it('rejects attaching an asset already attached to a step (has stepId)', async () => {
        stub([{ stepId: 's1', order: 1 }], {
          assets: { 'MEDIA#m1': { assetId: 'm1', taskId: 't1', stepId: 's2', s3Key: 'k' } },
        });
        await expect(
          handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'm1' } })),
        ).rejects.toThrow('already attached to a step');
      });

      it('rejects attaching an asset another step already points to', async () => {
        stub(
          [
            { stepId: 's1', order: 1 },
            { stepId: 's2', order: 2, mediaAssetId: 'm1' },
          ],
          { assets: { 'MEDIA#m1': { assetId: 'm1', taskId: 't1', s3Key: 'k' } } },
        );
        await expect(
          handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'm1' } })),
        ).rejects.toThrow('already attached to a step');
      });

      it('rejects attaching the Task cover image to a step', async () => {
        stub([{ stepId: 's1', order: 1 }], {
          cover: 'm1',
          assets: { 'MEDIA#m1': { assetId: 'm1', taskId: 't1', s3Key: 'k' } },
        });
        await expect(
          handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'm1' } })),
        ).rejects.toThrow('cannot attach the task cover image');
      });

      it('replacing step media attaches the new asset first, then deletes the old one', async () => {
        stub([{ stepId: 's1', order: 1, mediaAssetId: 'old' }], {
          assets: {
            'MEDIA#new': { assetId: 'new', taskId: 't1', s3Key: 'media/t1/new.png' },
            'MEDIA#old': { assetId: 'old', taskId: 't1', stepId: 's1', s3Key: 'media/t1/old.png' },
          },
        });
        const result = (await handler(
          event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaAssetId: 'new' } }),
        )) as TaskStep;

        // The atomic attach (transaction) happens; the old asset is purged afterward.
        expect(commands().some((c) => c.input.TransactItems)).toBe(true);
        expect(mockPurge).toHaveBeenCalledWith(
          expect.objectContaining({ assetId: 'old', s3Key: 'media/t1/old.png' }),
          expect.objectContaining({ event: 'updateTaskStep.replaceMedia' }),
        );
        expect(result.mediaAssetId).toBe('new');
      });
    });

    describe('removeMedia', () => {
      it('removes the back-reference and deletes the current media asset', async () => {
        stub([{ stepId: 's1', order: 1, mediaAssetId: 'm1' }], {
          assets: { 'MEDIA#m1': { assetId: 'm1', taskId: 't1', s3Key: 'media/t1/m1.png' } },
        });
        const result = (await handler(
          event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', removeMedia: true } }),
        )) as TaskStep;

        expect(updateInput().UpdateExpression).toContain('REMOVE mediaAssetId');
        expect(mockPurge).toHaveBeenCalledWith(
          expect.objectContaining({ assetId: 'm1' }),
          expect.objectContaining({ event: 'updateTaskStep.removeMedia' }),
        );
        expect(result.mediaAssetId).toBeUndefined();
      });

      it('is a no-op for media when the step has none (still updates the step)', async () => {
        stub([{ stepId: 's1', order: 1 }]);
        await handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', removeMedia: true } }));
        expect(updateInput().UpdateExpression).toContain('REMOVE mediaAssetId');
        expect(mockPurge).not.toHaveBeenCalled();
      });
    });
  });

  describe('deleteTask', () => {
    const meta = {
      PK: 'TASK#t1',
      SK: '#META',
      entityType: 'Task',
      taskId: 't1',
      ownerId: 'o1',
      title: 'T',
      taskCategoryKey: 'o1#NO_CATEGORY',
      createdAt: 'c',
    };
    const inputs = () => mockSend.mock.calls.map((c) => c[0].input);
    const deleteInputs = () => inputs().filter((i) => i.Key && i.ConditionExpression && !i.UpdateExpression);
    const batchInputs = () => inputs().filter((i) => i.RequestItems);
    const putBatches = () => batchInputs().filter((i) => i.RequestItems['CanPlan-test'][0]?.PutRequest);
    const deleteBatches = () => batchInputs().filter((i) => i.RequestItems['CanPlan-test'][0]?.DeleteRequest);

    it('deletes the #META item, all TaskStep rows, all MediaAsset rows, and their S3 objects', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } }) // GET #META
        .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#001' }, { PK: 'TASK#t1', SK: 'STEP#002' }] }) // STEP# keys
        .mockResolvedValueOnce({
          Items: [
            { PK: 'TASK#t1', SK: 'MEDIA#cover', assetId: 'cover', s3Key: 'media/t1/cover.png' },
            { PK: 'TASK#t1', SK: 'MEDIA#m2', assetId: 'm2', s3Key: 'media/t1/m2.jpg' },
          ],
        }) // MEDIA# items
        .mockResolvedValueOnce({}) // write cleanup journal
        .mockResolvedValueOnce({}) // delete children
        .mockResolvedValueOnce({
          Items: [
            { PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#cover', assetId: 'cover', s3Key: 'media/t1/cover.png' },
            { PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#m2', assetId: 'm2', s3Key: 'media/t1/m2.jpg' },
          ],
        }) // cleanup journal query
        .mockResolvedValueOnce({}) // delete cleanup journal
        .mockResolvedValueOnce({}); // Delete #META

      const result = (await handler(event('deleteTask', { taskId: 't1' }))) as Task;

      // Journal is persisted before deleting all 4 child rows (2 steps + 2 media).
      expect(putBatches()).toHaveLength(1);
      expect(putBatches()[0].RequestItems['CanPlan-test']).toHaveLength(2);
      expect(deleteBatches()[0].RequestItems['CanPlan-test']).toHaveLength(4);
      // The final delete batch removes the durable cleanup records after S3 succeeds.
      expect(deleteBatches()[1].RequestItems['CanPlan-test']).toHaveLength(2);
      // #META delete is the LAST DynamoDB call (children removed before parent).
      const lastCall = mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input;
      expect(lastCall.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
      // Each media binary is deleted from S3 (best-effort, after the rows).
      expect(mockDeleteS3).toHaveBeenCalledTimes(2);
      expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/cover.png', expect.objectContaining({ assetId: 'cover' }));
      expect(mockDeleteS3).toHaveBeenCalledWith('media/t1/m2.jpg', expect.objectContaining({ assetId: 'm2' }));
      // Returns the deleted metadata minus internal fields.
      expect(result.taskId).toBe('t1');
      const out = result as unknown as Record<string, unknown>;
      expect(out.PK).toBeUndefined();
      expect(out.SK).toBeUndefined();
      expect(out.entityType).toBeUndefined();
      expect(out.taskCategoryKey).toBeUndefined();
    });

    it('returns NotFound and writes nothing when the task does not exist', async () => {
      // Default mock returns {} (no Item) for the read.
      await expect(handler(event('deleteTask', { taskId: 'missing' }))).rejects.toThrow(
        'task missing not found',
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockDeleteS3).not.toHaveBeenCalled();
    });

    it('never touches Assignment/AssignmentStep snapshots (USER# partitions)', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } })
        .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#001' }] }) // STEP#
        .mockResolvedValueOnce({ Items: [] }) // MEDIA#
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await handler(event('deleteTask', { taskId: 't1' }));

      // Both child queries are scoped to this task's partition (STEP# then MEDIA#).
      const prefixes = inputs()
        .filter((i) => i.KeyConditionExpression)
        .map((i) => i.ExpressionAttributeValues[':prefix']);
      expect(prefixes).toEqual(['STEP#', 'MEDIA#', 'CLEANUP_MEDIA#']);
      // No command references a USER#/ASSIGN# key.
      const serialized = JSON.stringify(inputs());
      expect(serialized).not.toContain('USER#');
      expect(serialized).not.toContain('ASSIGN');
    });

    it('deletes >99 children across query pages in transaction-limit-safe batches of 25', async () => {
      const stepPage = (n: number, last?: boolean) => ({
        Items: Array.from({ length: n }, (_, i) => ({ PK: 'TASK#t1', SK: `STEP#${i}` })),
        LastEvaluatedKey: last ? undefined : { PK: 'TASK#t1', SK: 'last' },
      });
      const mediaItems = Array.from({ length: 10 }, (_, i) => ({
        PK: 'TASK#t1',
        SK: `MEDIA#m${i}`,
        assetId: `m${i}`,
        s3Key: `media/t1/m${i}.png`,
      }));
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } }) // GET #META
        .mockResolvedValueOnce(stepPage(60)) // step page 1 (more)
        .mockResolvedValueOnce(stepPage(60, true)) // step page 2 (last)
        .mockResolvedValueOnce({ Items: mediaItems }) // media (one page)
        .mockResolvedValueOnce({}) // write cleanup journal
        .mockResolvedValueOnce({}) // child delete batch 1
        .mockResolvedValueOnce({}) // child delete batch 2
        .mockResolvedValueOnce({}) // child delete batch 3
        .mockResolvedValueOnce({}) // child delete batch 4
        .mockResolvedValueOnce({}) // child delete batch 5
        .mockResolvedValueOnce({}) // child delete batch 6
        .mockResolvedValueOnce({
          Items: mediaItems.map((m) => ({
            PK: 'TASK#t1', SK: `CLEANUP_MEDIA#${m.assetId}`, assetId: m.assetId, s3Key: m.s3Key,
          })),
        }) // cleanup journal query
        .mockResolvedValueOnce({}) // cleanup journal delete
        .mockResolvedValueOnce({}); // #META delete

      await handler(event('deleteTask', { taskId: 't1' }));

      // 120 steps + 10 media = 130 child keys / 25 → 6 delete batches.
      expect(putBatches()).toHaveLength(1);
      expect(deleteBatches()).toHaveLength(7); // 6 children + 1 cleanup-journal batch
      const total = deleteBatches().slice(0, 6).reduce((n, i) => n + i.RequestItems['CanPlan-test'].length, 0);
      expect(total).toBe(130);
      // #META deleted exactly once, after the batches; every media binary cleaned up.
      expect(deleteInputs()).toHaveLength(1);
      expect(mockDeleteS3).toHaveBeenCalledTimes(10);
    });

    it('keeps the task and cleanup journal retryable when an S3 delete fails', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } })
        .mockResolvedValueOnce({ Items: [] }) // STEP#
        .mockResolvedValueOnce({
          Items: [{ PK: 'TASK#t1', SK: 'MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }],
        }) // MEDIA#
        .mockResolvedValueOnce({}) // write cleanup journal
        .mockResolvedValueOnce({}) // delete child metadata
        .mockResolvedValueOnce({
          Items: [{ PK: 'TASK#t1', SK: 'CLEANUP_MEDIA#m1', assetId: 'm1', s3Key: 'media/t1/m1.png' }],
        }); // cleanup journal query
      mockDeleteS3.mockResolvedValueOnce(false);

      await expect(handler(event('deleteTask', { taskId: 't1' }))).rejects.toThrow('could not be deleted');

      // The journal and #META are retained, so retrying the same API call can finish.
      expect(putBatches()).toHaveLength(1);
      expect(deleteBatches()).toHaveLength(1); // child only; journal was not deleted
      expect(deleteInputs()).toHaveLength(0); // #META was not deleted
    });

  });

  describe('deleteTaskStep', () => {
    const commands = () => mockSend.mock.calls.map((c) => c[0]);
    const stepDelete = () => commands().find((c) => c.constructor.name === 'DeleteCommand')?.input;

    /** Leak-free stub: STEP# query → `steps`; GET MEDIA#<id> → `asset` (or not-found). */
    const stub = (opts: { steps: Array<Record<string, unknown>>; asset?: Record<string, unknown> }) => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const { name } = cmd.constructor;
        if (name === 'QueryCommand') return Promise.resolve({ Items: opts.steps });
        if (name === 'GetCommand') return Promise.resolve(opts.asset ? { Item: opts.asset } : {});
        return Promise.resolve({}); // DeleteCommand
      });
    };

    it('deletes a step with no media and returns the deleted step payload', async () => {
      stub({ steps: [{ PK: 'TASK#t1', SK: 'STEP#001', entityType: 'TaskStep', stepId: 's1', taskId: 't1', order: 1, text: 'a' }] });
      const result = (await handler(
        event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }),
      )) as TaskStep;

      expect(stepDelete().Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#001' });
      expect(stepDelete().ConditionExpression).toBe('attribute_exists(PK)');
      expect(mockPurge).not.toHaveBeenCalled();
      // Returned payload excludes internal fields.
      expect(result.stepId).toBe('s1');
      const out = result as unknown as Record<string, unknown>;
      expect(out.PK).toBeUndefined();
      expect(out.SK).toBeUndefined();
      expect(out.entityType).toBeUndefined();
    });

    it('returns NotFound when no STEP# row has the given stepId', async () => {
      stub({ steps: [{ stepId: 'other', order: 1 }] });
      await expect(
        handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 'missing' } })),
      ).rejects.toThrow('step missing not found for task t1');
      expect(commands().some((c) => c.constructor.name === 'DeleteCommand')).toBe(false);
      expect(mockPurge).not.toHaveBeenCalled();
    });

    it('validates blank taskId and stepId before any DynamoDB call', async () => {
      await expect(handler(event('deleteTaskStep', { input: { stepId: 's1' } }))).rejects.toThrow('taskId is required');
      await expect(handler(event('deleteTaskStep', { input: { taskId: '  ', stepId: 's1' } }))).rejects.toThrow('taskId is required');
      await expect(handler(event('deleteTaskStep', { input: { taskId: 't1' } }))).rejects.toThrow('stepId is required');
      await expect(handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: '  ' } }))).rejects.toThrow('stepId is required');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('deletes the step and its single media asset (metadata row + S3 binary)', async () => {
      stub({
        steps: [{ stepId: 's1', order: 1, mediaAssetId: 'm1' }],
        asset: { assetId: 'm1', taskId: 't1', stepId: 's1', s3Key: 'media/t1/m1.png' },
      });
      await handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }));

      // Step row deleted, then the single asset purged (row + S3) via the shared helper.
      expect(stepDelete().Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#001' });
      expect(mockPurge).toHaveBeenCalledTimes(1);
      expect(mockPurge).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'm1', s3Key: 'media/t1/m1.png' }),
        expect.objectContaining({ event: 'deleteTaskStep', taskId: 't1', stepId: 's1' }),
      );
    });

    it('treats an already-gone media asset as cleaned (no purge, still succeeds)', async () => {
      stub({ steps: [{ stepId: 's1', order: 1, mediaAssetId: 'm1' }] }); // GET asset → {}
      const result = (await handler(
        event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }),
      )) as TaskStep;
      expect(result.stepId).toBe('s1');
      expect(mockPurge).not.toHaveBeenCalled();
    });

    it('does not read, update, or delete any Assignment/AssignmentStep rows', async () => {
      stub({
        steps: [{ stepId: 's1', order: 1, mediaAssetId: 'm1' }],
        asset: { assetId: 'm1', taskId: 't1', stepId: 's1', s3Key: 'media/t1/m1.png' },
      });
      await handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }));
      const serialized = JSON.stringify(commands().map((c) => c.input));
      expect(serialized).not.toContain('USER#');
      expect(serialized).not.toContain('ASSIGN');
    });

    it('finds the step across paginated STEP# pages', async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ stepId: 'other', order: 1 }], LastEvaluatedKey: { k: 1 } }) // page 1
        .mockResolvedValueOnce({ Items: [{ stepId: 's1', order: 2 }] }) // page 2 has the target
        .mockResolvedValue({}); // step delete (no media)
      const result = (await handler(
        event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } }),
      )) as TaskStep;
      expect(result.stepId).toBe('s1');
      expect(stepDelete().Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#002' });
    });

    it('surfaces a retryable error when the S3 cleanup fails (no silent success)', async () => {
      mockPurge.mockResolvedValueOnce(false); // S3 delete failed
      stub({
        steps: [{ stepId: 's1', order: 1, mediaAssetId: 'm1' }],
        asset: { assetId: 'm1', taskId: 't1', stepId: 's1', s3Key: 'media/t1/m1.png' },
      });
      await expect(
        handler(event('deleteTaskStep', { input: { taskId: 't1', stepId: 's1' } })),
      ).rejects.toThrow('could not be deleted; retry');
      // The step remains until the durable media cleanup succeeds, so retrying this
      // same mutation can finish safely rather than returning NotFound.
      expect(stepDelete()).toBeUndefined();
      expect(mockRetryMediaCleanup).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ event: 'deleteTaskStep.retryPendingCleanup', stepId: 's1' }),
      );
    });
  });

  it('createTaskStep writes PK=TASK#<id> with a zero-padded STEP# sort key', async () => {
    const result = (await handler(
      event('createTaskStep', { input: { taskId: 't1', order: 7, text: 'Rinse' } }),
    )) as TaskStep;
    const { Item } = lastInput();
    expect(Item.PK).toBe('TASK#t1');
    expect(Item.SK).toBe('STEP#007');
    expect(Item.entityType).toBe('TaskStep');
    expect(Item.order).toBe(7);
    expect(Item.text).toBe('Rinse');
    expect(typeof Item.stepId).toBe('string');
    expect(result.stepId).toBe(Item.stepId);
  });

  it('createTaskStep validates taskId, text, and a positive integer order', async () => {
    await expect(handler(event('createTaskStep', { input: { order: 1, text: 'x' } }))).rejects.toThrow(
      'taskId is required',
    );
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 1, text: '' } })),
    ).rejects.toThrow('text is required');
    await expect(
      handler(event('createTaskStep', { input: { taskId: 't1', order: 0, text: 'x' } })),
    ).rejects.toThrow('order is required');
  });

  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
