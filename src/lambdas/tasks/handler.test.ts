import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { Connection, TaskStep } from '../../shared/types';

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
