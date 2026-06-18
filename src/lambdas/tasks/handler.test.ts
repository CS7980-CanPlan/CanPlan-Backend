import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { Connection, Task, TaskStep } from '../../shared/types';

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
