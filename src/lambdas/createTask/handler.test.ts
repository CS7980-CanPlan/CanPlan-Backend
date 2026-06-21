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

beforeEach(() => {
  mockSend.mockResolvedValue({});
});

afterEach(() => {
  jest.clearAllMocks();
});

type Input = Parameters<typeof handler>[0]['arguments']['input'];

function makeEvent(input: Partial<Input>) {
  return { arguments: { input }, info: { fieldName: 'createTask' } } as Parameters<typeof handler>[0];
}

/** Pull the items out of the single TransactWrite the handler issues. */
function writtenItems(): Array<Record<string, unknown>> {
  const cmd = mockSend.mock.calls[0][0];
  return cmd.input.TransactItems.map((t: { Put: { Item: Record<string, unknown> } }) => t.Put.Item);
}

describe('createTask handler', () => {
  it('writes a Task #META item with PK=TASK#<taskId>, SK=#META and the owner/createdAt GSI fields', async () => {
    const result = await handler(
      makeEvent({ ownerId: 'sup-1', title: 'Make tea', categoryId: 'cat-1', description: 'green tea' }),
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const items = writtenItems();
    const meta = items.find((i) => i.SK === '#META')!;

    expect(meta.PK).toBe(`TASK#${result.taskId}`);
    expect(meta.SK).toBe('#META');
    expect(meta.entityType).toBe('Task');
    // taskOwnerIndex fields must be present on the Task item.
    expect(meta.ownerId).toBe('sup-1');
    expect(typeof meta.createdAt).toBe('string');
    expect(meta.title).toBe('Make tea');
    expect(meta.status).toBe('DRAFT');
    // Steps are stored as separate items, never embedded on the Task item.
    expect(meta.steps).toBeUndefined();
  });

  it('writes each nested step as its own item with zero-padded STEP#001, STEP#002, STEP#003 keys', async () => {
    const result = await handler(
      makeEvent({
        ownerId: 'sup-1',
        title: 'Brush teeth',
        steps: [{ text: 'Wet the brush' }, { text: 'Add toothpaste' }, { text: 'Brush' }],
      }),
    );

    const steps = writtenItems().filter((i) => i.entityType === 'TaskStep');
    expect(steps.map((s) => s.SK)).toEqual(['STEP#001', 'STEP#002', 'STEP#003']);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3]);
    for (const step of steps) {
      expect(step.PK).toBe(`TASK#${result.taskId}`);
      expect(step.taskId).toBe(result.taskId);
      expect(typeof step.stepId).toBe('string');
    }
    // Returned task carries the steps it just wrote.
    expect(result.steps).toHaveLength(3);
  });

  it('generates a unique taskId and a stepId per step', async () => {
    const result = await handler(makeEvent({ ownerId: 'o', title: 'T', steps: [{ text: 'a' }, { text: 'b' }] }));
    expect(result.taskId).toMatch(/[0-9a-f-]{36}/);
    const stepIds = result.steps!.map((s) => s.stepId);
    expect(new Set(stepIds).size).toBe(2);
  });

  it('writes only the Task item when no steps are provided', async () => {
    await handler(makeEvent({ ownerId: 'o', title: 'No steps' }));
    expect(writtenItems()).toHaveLength(1);
  });

  it('honors a provided status', async () => {
    const result = await handler(makeEvent({ ownerId: 'o', title: 'T', status: 'ACTIVE' }));
    expect(result.status).toBe('ACTIVE');
  });

  it('defaults a missing categoryId to NO_CATEGORY and derives taskCategoryKey', async () => {
    const result = await handler(makeEvent({ ownerId: 'sup-1', title: 'T' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.categoryId).toBe('NO_CATEGORY');
    expect(meta.taskCategoryKey).toBe('sup-1#NO_CATEGORY');
    expect(result.categoryId).toBe('NO_CATEGORY');
  });

  it('defaults a blank categoryId to NO_CATEGORY', async () => {
    await handler(makeEvent({ ownerId: 'sup-1', title: 'T', categoryId: '   ' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.categoryId).toBe('NO_CATEGORY');
    expect(meta.taskCategoryKey).toBe('sup-1#NO_CATEGORY');
  });

  it('stores an explicit categoryId and the matching taskCategoryKey', async () => {
    await handler(makeEvent({ ownerId: 'sup-1', title: 'T', categoryId: 'cat-9' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.categoryId).toBe('cat-9');
    expect(meta.taskCategoryKey).toBe('sup-1#cat-9');
  });

  it('stores valid schedule metadata, defaults enabled, and sets nextOccurrenceAt', async () => {
    const result = await handler(
      makeEvent({
        ownerId: 'o',
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
    // notificationEnabled defaults to true alongside a schedule.
    expect(meta.notificationEnabled).toBe(true);
    expect(result.nextOccurrenceAt).toBe('2026-07-01T09:00:00Z');
  });

  it('honors an explicit schedule.enabled=false and notificationEnabled=false', async () => {
    await handler(
      makeEvent({
        ownerId: 'o',
        title: 'T',
        notificationEnabled: false,
        schedule: {
          repeatEvery: 1,
          repeatUnit: 'WEEK',
          firstOccurrenceAt: '2026-07-01T09:00:00Z',
          timezone: 'UTC',
          enabled: false,
        },
      }),
    );
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect((meta.schedule as { enabled: boolean }).enabled).toBe(false);
    expect(meta.notificationEnabled).toBe(false);
  });

  it('leaves schedule fields unset when no schedule is provided', async () => {
    const result = await handler(makeEvent({ ownerId: 'o', title: 'T' }));
    const meta = writtenItems().find((i) => i.SK === '#META')!;
    expect(meta.schedule).toBeUndefined();
    expect(meta.nextOccurrenceAt).toBeUndefined();
    expect(meta.notificationEnabled).toBeUndefined();
    expect(result.schedule).toBeUndefined();
  });

  it('rejects a schedule with a non-positive repeatEvery', async () => {
    await expect(
      handler(
        makeEvent({
          ownerId: 'o',
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
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a schedule missing firstOccurrenceAt or timezone', async () => {
    await expect(
      handler(
        makeEvent({
          ownerId: 'o',
          title: 'T',
          schedule: {
            repeatEvery: 1,
            repeatUnit: 'DAY',
            firstOccurrenceAt: '   ',
            timezone: 'UTC',
          },
        }),
      ),
    ).rejects.toThrow('firstOccurrenceAt is required');
    await expect(
      handler(
        makeEvent({
          ownerId: 'o',
          title: 'T',
          schedule: {
            repeatEvery: 1,
            repeatUnit: 'DAY',
            firstOccurrenceAt: '2026-07-01T09:00:00Z',
            timezone: '',
          },
        }),
      ),
    ).rejects.toThrow('timezone is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when ownerId is missing', async () => {
    await expect(handler(makeEvent({ title: 'T' }))).rejects.toThrow('ownerId is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when title is missing', async () => {
    await expect(handler(makeEvent({ ownerId: 'o' }))).rejects.toThrow('title is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when a step has empty text', async () => {
    await expect(
      handler(makeEvent({ ownerId: 'o', title: 'T', steps: [{ text: '  ' }] })),
    ).rejects.toThrow('step 1: text is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    { coverImageS3Key: undefined, stepCount: 100, maxSteps: 99 },
    { coverImageS3Key: 'media/pending/task-cover/u.png', stepCount: 99, maxSteps: 98 },
  ])('rejects $stepCount steps when the limit is $maxSteps', async ({ coverImageS3Key, stepCount, maxSteps }) => {
    const steps = Array.from({ length: stepCount }, (_, i) => ({ text: `Step ${i + 1}` }));

    await expect(handler(makeEvent({ ownerId: 'o', title: 'T', steps, coverImageS3Key }))).rejects.toThrow(
      `at most ${maxSteps} steps`,
    );
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('cover image', () => {
    it('does not touch S3 / cover logic when no coverImageS3Key is supplied', async () => {
      const result = await handler(makeEvent({ ownerId: 'o', title: 'T' }));
      expect(mockPrepare).not.toHaveBeenCalled();
      const meta = writtenItems().find((i) => i.SK === '#META')!;
      expect(meta.coverImageAssetId).toBeUndefined();
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
        makeEvent({ ownerId: 'sup-1', title: 'T', coverImageS3Key: 'media/pending/task-cover/u.png' }),
      );

      // prepare was called with the server-generated taskId + owner + pending key.
      expect(mockPrepare).toHaveBeenCalledWith({
        taskId: result.taskId,
        ownerId: 'sup-1',
        coverImageS3Key: 'media/pending/task-cover/u.png',
      });

      // One transaction carrying the Task (+coverImageAssetId) and the MediaAsset row.
      expect(mockSend).toHaveBeenCalledTimes(1);
      const items = writtenItems();
      const meta = items.find((i) => i.SK === '#META')!;
      expect(meta.coverImageAssetId).toBe('cover-1');
      const media = items.find((i) => i.entityType === 'MediaAsset')!;
      expect(media.SK).toBe('MEDIA#cover-1');
      expect(media.PK).toBe(`TASK#${result.taskId}`);
      expect(media.type).toBe('IMAGE');
      expect(media.s3Key).toBe('media/placeholder/cover-1.png');
      expect(result.coverImageAssetId).toBe('cover-1');
    });

    it('best-effort deletes the copied S3 object and rethrows when the write fails', async () => {
      mockPrepare.mockResolvedValueOnce({
        assetId: 'cover-1',
        s3Key: 'media/x/cover-1.png',
        type: 'IMAGE',
        mimeType: 'image/png',
        ownerId: 'o',
        taskId: 'x',
        createdAt: 'now',
        updatedAt: 'now',
      });
      mockSend.mockRejectedValueOnce(new Error('transaction canceled'));

      await expect(
        handler(makeEvent({ ownerId: 'o', title: 'T', coverImageS3Key: 'media/pending/task-cover/u.png' })),
      ).rejects.toThrow('transaction canceled');
      // The orphaned final object is cleaned up; original error preserved.
      expect(mockDeleteS3).toHaveBeenCalledWith('media/x/cover-1.png', expect.objectContaining({ event: 'createTask.coverRollback' }));
    });
  });
});
