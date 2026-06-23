import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { deleteS3ObjectBestEffort, prepareCoverImageAsset } from '../../shared/media';

// Mock the DynamoDB document client so tests never hit AWS.
jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

// Cover-image S3 work (HeadObject/CopyObject/DeleteObject) is unit-tested in
// shared/media.test.ts; here we stub it to focus on the create transaction + rollback.
jest.mock('../../shared/media', () => ({
  prepareCoverImageAsset: jest.fn(),
  deleteS3ObjectBestEffort: jest.fn().mockResolvedValue(true),
}));

const mockSend = dynamo.send as jest.Mock;
const mockPrepare = prepareCoverImageAsset as jest.Mock;
const mockDeleteS3 = deleteS3ObjectBestEffort as jest.Mock;

/**
 * Default DB behaviour: profile GET → a default category id; any CATEGORY# GET → a valid,
 * owned, non-deleting category; every write → {}. Individual tests override as needed.
 */
function stubDb(
  opts: { defaultId?: string | null; category?: Record<string, unknown> | null } = {},
) {
  const { defaultId = 'def-1' } = opts;
  mockSend.mockImplementation(
    (cmd: { constructor: { name: string }; input: { Key?: { PK?: string; SK?: string } } }) => {
      if (cmd.constructor.name === 'GetCommand') {
        const sk = cmd.input.Key?.SK ?? '';
        const pk = cmd.input.Key?.PK ?? '';
        const owner = pk.startsWith('USER#') ? pk.slice('USER#'.length) : 'sup-1';
        if (sk === '#PROFILE') {
          return Promise.resolve(
            defaultId ? { Item: { userId: owner, defaultCategoryId: defaultId } } : { Item: {} },
          );
        }
        if (sk.startsWith('CATEGORY#')) {
          const id = sk.slice('CATEGORY#'.length);
          // The owner's default category must validate as a real default (getDefaultCategoryId
          // reads it strongly-consistently and checks owner + isDefault + reserved name).
          if (id === defaultId) {
            return Promise.resolve({
              Item: { categoryId: id, ownerId: owner, isDefault: true, name: 'No Category', taskCount: 0 },
            });
          }
          if (opts.category === null) return Promise.resolve({});
          return Promise.resolve({
            Item: opts.category ?? { categoryId: id, ownerId: owner, isDefault: false },
          });
        }
      }
      return Promise.resolve({});
    },
  );
}

beforeEach(() => stubDb());
afterEach(() => jest.clearAllMocks());

type Input = Parameters<typeof handler>[0]['arguments']['input'];

function makeEvent(input: Partial<Input>, sub: string | null = 'sup-1') {
  return {
    arguments: { input },
    info: { fieldName: 'createTask' },
    identity: sub ? { sub } : undefined,
  } as Parameters<typeof handler>[0];
}

/** The single TransactWrite the handler issues, and its written (Put) items. */
function transaction() {
  return mockSend.mock.calls.map((c) => c[0]).find((c) => c.input.TransactItems);
}
function writtenItems(): Array<Record<string, unknown>> {
  return transaction()
    .input.TransactItems.filter((t: { Put?: unknown }) => t.Put)
    .map((t: { Put: { Item: Record<string, unknown> } }) => t.Put.Item);
}

describe('createTask handler', () => {
  it('derives ownerId from the identity and writes a Task #META item without a status field', async () => {
    const result = await handler(
      makeEvent({ title: 'Make tea', categoryId: 'cat-1', description: 'green tea' }, 'sup-9'),
    );

    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.PK).toBe(`TASK#${result.taskId}`);
    expect(meta.entityType).toBe('Task');
    expect(meta.ownerId).toBe('sup-9');
    expect(meta.title).toBe('Make tea');
    expect(meta.status).toBeUndefined();
    expect(result.ownerId).toBe('sup-9');
  });

  it('ignores any client-supplied ownerId — only the identity is trusted', async () => {
    const result = await handler(
      makeEvent({ ownerId: 'victim', title: 'T' } as Record<string, unknown>, 'me'),
    );
    expect(result.ownerId).toBe('me');
    expect(writtenItems().find((i) => i.SK === '#META')!.ownerId).toBe('me');
  });

  it('writes each nested step as its own STEP#<stepId> item with 1-based order', async () => {
    const result = await handler(
      makeEvent({
        title: 'Brush teeth',
        steps: [{ text: 'Wet the brush' }, { text: 'Add toothpaste' }, { text: 'Brush' }],
      }),
    );

    const steps = writtenItems().filter((i) => i.entityType === 'TaskStep');
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3]);
    for (const step of steps) {
      expect(step.PK).toBe(`TASK#${result.taskId}`);
      expect(step.SK).toBe(`STEP#${step.stepId}`);
      expect(step.taskId).toBe(result.taskId);
      expect(step.mediaVersion).toBe(0);
    }
    expect(result.steps).toHaveLength(3);
    expect(result.steps?.every((step) => Array.isArray(step.mediaAssets) && step.mediaAssets.length === 0)).toBe(
      true,
    );
    expect(steps.every((step) => step.mediaAssets === undefined)).toBe(true);
    // Step metadata initialized for concurrency-safe appends: 3 steps ⇒ next append at 4.
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.stepCount).toBe(3);
    expect(meta.stepVersion).toBe(1);
    expect(meta.nextStepOrder).toBe(4);
  });

  it('initializes step metadata to a zero/empty baseline when no steps are nested', async () => {
    const result = await handler(makeEvent({ title: 'T' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.stepCount).toBe(0);
    expect(meta.stepVersion).toBe(1);
    expect(meta.nextStepOrder).toBe(1);
    expect(result.taskId).toBeDefined();
  });

  it('persists nested step descriptions (trimmed; empty dropped)', async () => {
    const result = await handler(
      makeEvent({
        title: 'T',
        steps: [
          { text: 'a', description: '  more info  ' },
          { text: 'b', description: '   ' },
          { text: 'c' },
        ],
      }),
    );
    const steps = writtenItems().filter((i) => i.entityType === 'TaskStep');
    expect(steps[0].description).toBe('more info');
    expect(steps[1].description).toBeUndefined();
    expect(steps[2].description).toBeUndefined();
    expect(result.steps![0].description).toBe('more info');
  });

  it("files a task with no categoryId under the owner's default category", async () => {
    const result = await handler(makeEvent({ title: 'T' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.categoryId).toBe('def-1');
    expect(meta.taskCategoryKey).toBe('sup-1#def-1');
    expect(result.categoryId).toBe('def-1');
  });

  it('rejects a blank categoryId rather than silently defaulting it', async () => {
    await expect(handler(makeEvent({ title: 'T', categoryId: '   ' }))).rejects.toThrow(
      'categoryId cannot be blank',
    );
    expect(transaction()).toBeUndefined();
  });

  it('stores a supplied, validated categoryId and its taskCategoryKey', async () => {
    await handler(makeEvent({ title: 'T', categoryId: 'cat-9' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.categoryId).toBe('cat-9');
    expect(meta.taskCategoryKey).toBe('sup-1#cat-9');
  });

  it('increments the category taskCount in the create transaction, guarded against deletion', async () => {
    await handler(makeEvent({ title: 'T', categoryId: 'cat-9' }));
    const countUpdate = transaction().input.TransactItems.find(
      (t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === 'CATEGORY#cat-9',
    );
    expect(countUpdate.Update.UpdateExpression).toContain('ADD #taskCount :delta');
    expect(countUpdate.Update.ExpressionAttributeValues[':delta']).toBe(1);
    expect(countUpdate.Update.ConditionExpression).toContain('attribute_not_exists(deleting)');
  });

  it('increments the default category taskCount when no categoryId is supplied', async () => {
    await handler(makeEvent({ title: 'T' }));
    const countUpdate = transaction().input.TransactItems.find(
      (t: { Update?: { Key?: { SK?: string } } }) => t.Update?.Key?.SK === 'CATEGORY#def-1',
    );
    expect(countUpdate.Update.ExpressionAttributeValues[':delta']).toBe(1);
  });

  it('rejects a missing/foreign category, and a category being deleted', async () => {
    stubDb({ category: null }); // CATEGORY# GET → not found
    await expect(handler(makeEvent({ title: 'T', categoryId: 'nope' }))).rejects.toThrow(
      'category nope not found for owner sup-1',
    );
    stubDb({ category: { categoryId: 'c', ownerId: 'sup-1', isDefault: false, deleting: true } });
    await expect(handler(makeEvent({ title: 'T', categoryId: 'c' }))).rejects.toThrow(
      'being deleted',
    );
  });

  it('fails clearly when the owner has no profile / no default category', async () => {
    stubDb({ defaultId: null });
    await expect(handler(makeEvent({ title: 'T' }))).rejects.toThrow('no default category');
  });

  it('stores valid schedule metadata, defaults enabled, and sets nextOccurrenceAt', async () => {
    const result = await handler(
      makeEvent({
        title: 'Take meds',
        schedule: {
          repeatEvery: 2,
          repeatUnit: 'DAY',
          firstOccurrenceAt: '2026-07-01T09:00:00Z',
          timezone: 'America/Toronto',
        },
      }),
    );
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.schedule).toEqual({
      repeatEvery: 2,
      repeatUnit: 'DAY',
      firstOccurrenceAt: '2026-07-01T09:00:00Z',
      timezone: 'America/Toronto',
      enabled: true,
    });
    expect(meta.nextOccurrenceAt).toBe('2026-07-01T09:00:00Z');
    expect(meta.notificationEnabled).toBe(true);
    expect(result.nextOccurrenceAt).toBe('2026-07-01T09:00:00Z');
  });

  it('leaves schedule fields unset when no schedule is provided', async () => {
    const result = await handler(makeEvent({ title: 'T' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.schedule).toBeUndefined();
    expect(meta.nextOccurrenceAt).toBeUndefined();
    expect(result.schedule).toBeUndefined();
  });

  it('rejects a schedule with a non-positive repeatEvery', async () => {
    await expect(
      handler(
        makeEvent({
          title: 'T',
          schedule: {
            repeatEvery: 0,
            repeatUnit: 'DAY',
            firstOccurrenceAt: '2026-07-01T09:00:00Z',
            timezone: 'UTC',
          },
        }),
      ),
    ).rejects.toThrow('repeatEvery must be a positive integer');
    expect(transaction()).toBeUndefined();
  });

  it('rejects an unauthenticated caller (no identity sub)', async () => {
    await expect(handler(makeEvent({ title: 'T' }, null))).rejects.toThrow(
      'authenticated user is required',
    );
  });

  it('throws ValidationError when title is missing', async () => {
    await expect(handler(makeEvent({}))).rejects.toThrow('title is required');
  });

  it('throws ValidationError when a step has empty text', async () => {
    await expect(handler(makeEvent({ title: 'T', steps: [{ text: '  ' }] }))).rejects.toThrow(
      'step 1: text is required',
    );
  });

  it.each([
    { coverImageS3Key: undefined, stepCount: 99, maxSteps: 98 },
    { coverImageS3Key: 'media/pending/task-cover/u.png', stepCount: 98, maxSteps: 97 },
  ])(
    'rejects $stepCount steps when the limit is $maxSteps (task + category check + cover)',
    async ({ coverImageS3Key, stepCount, maxSteps }) => {
      const steps = Array.from({ length: stepCount }, (_, i) => ({ text: `Step ${i + 1}` }));
      await expect(handler(makeEvent({ title: 'T', steps, coverImageS3Key }))).rejects.toThrow(
        `at most ${maxSteps} steps`,
      );
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(transaction()).toBeUndefined();
    },
  );

  describe('cover image', () => {
    it('does not touch cover logic when no coverImageS3Key is supplied', async () => {
      const result = await handler(makeEvent({ title: 'T' }));
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(result.coverImageAssetId).toBeUndefined();
    });

    it('promotes the upload and writes the cover MediaAsset in the same transaction', async () => {
      mockPrepare.mockResolvedValueOnce({
        assetId: 'cover-1',
        taskId: 'placeholder',
        s3Key: 'media/placeholder/cover-1.png',
        type: 'IMAGE',
        mimeType: 'image/png',
        ownerId: 'sup-1',
        size: 2048,
        createdAt: 'now',
        updatedAt: 'now',
      });

      const result = await handler(
        makeEvent({ title: 'T', coverImageS3Key: 'media/pending/task-cover/u.png' }),
      );

      expect(mockPrepare).toHaveBeenCalledWith({
        taskId: result.taskId,
        ownerId: 'sup-1',
        coverImageS3Key: 'media/pending/task-cover/u.png',
      });
      const items = writtenItems();
      const meta = items.find((i) => i.SK === '#META')!;
      expect(meta.coverImageAssetId).toBe('cover-1');
      const media = items.find((i) => i.entityType === 'MediaAsset')!;
      expect(media.SK).toBe('MEDIA#cover-1');
      expect(result.coverImageAssetId).toBe('cover-1');
    });

    it('best-effort deletes the copied S3 object and rethrows when the write fails', async () => {
      mockPrepare.mockResolvedValueOnce({
        assetId: 'cover-1',
        s3Key: 'media/x/cover-1.png',
        type: 'IMAGE',
        mimeType: 'image/png',
        ownerId: 'sup-1',
        taskId: 'x',
        createdAt: 'now',
        updatedAt: 'now',
      });
      // Reads succeed; the TransactWrite fails.
      mockSend.mockImplementation(
        (cmd: {
          constructor: { name: string };
          input: { Key?: { SK?: string }; TransactItems?: unknown };
        }) => {
          if (cmd.input.TransactItems) return Promise.reject(new Error('transaction canceled'));
          if (cmd.constructor.name === 'GetCommand') {
            const sk = cmd.input.Key?.SK ?? '';
            if (sk === '#PROFILE') return Promise.resolve({ Item: { defaultCategoryId: 'def-1' } });
            if (sk.startsWith('CATEGORY#'))
              return Promise.resolve({
                Item: { categoryId: 'def-1', ownerId: 'sup-1', isDefault: true, name: 'No Category' },
              });
          }
          return Promise.resolve({});
        },
      );

      await expect(
        handler(makeEvent({ title: 'T', coverImageS3Key: 'media/pending/task-cover/u.png' })),
      ).rejects.toThrow('transaction canceled');
      expect(mockDeleteS3).toHaveBeenCalledWith(
        'media/x/cover-1.png',
        expect.objectContaining({ event: 'createTask.coverRollback' }),
      );
    });
  });
});
