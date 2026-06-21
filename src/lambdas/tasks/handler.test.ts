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

  describe('updateTaskStep', () => {
    // findTaskStep queries STEP# rows; the matching row carries the real `order`.
    const stubStep = (rows: Array<Record<string, unknown>>, attrs: Record<string, unknown>) =>
      mockSend.mockResolvedValueOnce({ Items: rows }).mockResolvedValueOnce({ Attributes: attrs });
    const updateInput = () => mockSend.mock.calls.find((c) => c[0].input.UpdateExpression)![0].input;

    it('updates text (trimmed) on the row found by stepId, keyed by its order', async () => {
      stubStep(
        [{ stepId: 's1', order: 3, taskId: 't1', text: 'old', createdAt: 'c' }],
        { PK: 'TASK#t1', SK: 'STEP#003', entityType: 'TaskStep', stepId: 's1', order: 3, text: 'Rinse', updatedAt: 'now' },
      );
      const result = (await handler(
        event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: '  Rinse  ' } }),
      )) as TaskStep;

      const input = updateInput();
      // Keyed by the step's stored order, never reconstructed from stepId.
      expect(input.Key).toEqual({ PK: 'TASK#t1', SK: 'STEP#003' });
      expect(input.UpdateExpression).toContain('#text = :text');
      expect(input.ExpressionAttributeValues[':text']).toBe('Rinse');
      expect(input.ConditionExpression).toBe('attribute_exists(PK)');
      // Result is stripped of internal storage attributes.
      const out = result as unknown as Record<string, unknown>;
      expect(out.PK).toBeUndefined();
      expect(out.SK).toBeUndefined();
      expect(out.entityType).toBeUndefined();
      expect(result.text).toBe('Rinse');
    });

    it('replaces mediaRefs, including with an empty list', async () => {
      stubStep(
        [{ stepId: 's1', order: 1 }],
        { stepId: 's1', order: 1, mediaRefs: [], updatedAt: 'now' },
      );
      await handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', mediaRefs: [] } }));
      const input = updateInput();
      expect(input.UpdateExpression).toContain('#mediaRefs = :mediaRefs');
      expect(input.ExpressionAttributeValues[':mediaRefs']).toEqual([]);
      // text was not supplied, so it is not in the update.
      expect(input.UpdateExpression).not.toContain(':text');
    });

    it('rejects an empty (whitespace) text before touching DynamoDB', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1', text: '   ' } })),
      ).rejects.toThrow('text cannot be empty');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects a request with neither text nor mediaRefs', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 's1' } })),
      ).rejects.toThrow('at least one of text or mediaRefs');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns NotFound when no STEP# row has the given stepId', async () => {
      mockSend.mockResolvedValueOnce({ Items: [{ stepId: 'other', order: 1 }] });
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', stepId: 'missing', text: 'x' } })),
      ).rejects.toThrow('step missing not found for task t1');
      // Found nothing → never issued an update.
      expect(mockSend.mock.calls.some((c) => c[0].input.UpdateExpression)).toBe(false);
    });

    it('validates taskId and stepId', async () => {
      await expect(
        handler(event('updateTaskStep', { input: { stepId: 's1', text: 'x' } })),
      ).rejects.toThrow('taskId is required');
      await expect(
        handler(event('updateTaskStep', { input: { taskId: 't1', text: 'x' } })),
      ).rejects.toThrow('stepId is required');
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

    it('deletes the #META item and all TaskStep rows (steps first, meta last)', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } }) // GET #META
        .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#001' }, { PK: 'TASK#t1', SK: 'STEP#002' }] })
        .mockResolvedValueOnce({}) // BatchWrite
        .mockResolvedValueOnce({}); // Delete #META

      const result = (await handler(event('deleteTask', { taskId: 't1' }))) as Task;

      // One batch delete carrying both step keys …
      const batch = batchInputs();
      expect(batch).toHaveLength(1);
      expect(batch[0].RequestItems['CanPlan-test']).toHaveLength(2);
      // … and the #META delete is the LAST DynamoDB call (steps removed before parent).
      const lastCall = mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input;
      expect(lastCall.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
      expect(lastCall.ConditionExpression).toBe('attribute_exists(PK)');
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
    });

    it('never touches Assignment/AssignmentStep snapshots (USER# partitions)', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } })
        .mockResolvedValueOnce({ Items: [{ PK: 'TASK#t1', SK: 'STEP#001' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await handler(event('deleteTask', { taskId: 't1' }));

      // The step query is scoped to this task's STEP# prefix only.
      const stepQuery = inputs().find((i) => i.KeyConditionExpression)!;
      expect(stepQuery.ExpressionAttributeValues).toEqual({ ':pk': 'TASK#t1', ':prefix': 'STEP#' });
      // No command references a USER#/ASSIGN# key.
      const serialized = JSON.stringify(inputs());
      expect(serialized).not.toContain('USER#');
      expect(serialized).not.toContain('ASSIGN');
    });

    it('deletes >99 steps across query pages in transaction-limit-safe batches of 25', async () => {
      const page = (n: number, last?: boolean) => ({
        Items: Array.from({ length: n }, (_, i) => ({ PK: 'TASK#t1', SK: `STEP#${i}` })),
        LastEvaluatedKey: last ? undefined : { PK: 'TASK#t1', SK: 'last' },
      });
      mockSend
        .mockResolvedValueOnce({ Item: { ...meta } }) // GET #META
        .mockResolvedValueOnce(page(60)) // step page 1 (more)
        .mockResolvedValueOnce(page(60, true)) // step page 2 (last)
        .mockResolvedValue({}); // every BatchWrite + final Delete

      await handler(event('deleteTask', { taskId: 't1' }));

      // 120 keys / 25 per batch → 5 BatchWrite calls (no transaction-limit failure).
      expect(batchInputs()).toHaveLength(5);
      const total = batchInputs().reduce((n, i) => n + i.RequestItems['CanPlan-test'].length, 0);
      expect(total).toBe(120);
      // #META deleted exactly once, after the batches.
      expect(deleteInputs()).toHaveLength(1);
    });

    it('has no API for deleting an individual TaskStep', async () => {
      await expect(handler(event('deleteTaskStep', { taskId: 't1', stepId: 's1' }))).rejects.toThrow(
        'unsupported field',
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
