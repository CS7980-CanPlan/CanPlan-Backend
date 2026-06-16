import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { Assignment, Connection } from '../../shared/types';

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

describe('assignments handler', () => {
  it('createAssignment writes PK=USER#<userId>, SK=ASSIGN#<assignmentId> (NOT ASSIGN#<taskId>)', async () => {
    const result = (await handler(
      event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } }),
    )) as Assignment;
    const { Item } = lastInput();

    expect(Item.PK).toBe('USER#u1');
    // SK is keyed by the generated assignmentId...
    expect(Item.SK).toBe(`ASSIGN#${Item.assignmentId}`);
    expect(result.assignmentId).toBe(Item.assignmentId);
    // ...and explicitly NOT by the taskId.
    expect(Item.SK).not.toBe('ASSIGN#task-1');
    // taskId is stored as a normal attribute.
    expect(Item.taskId).toBe('task-1');
    expect(Item.entityType).toBe('Assignment');
    expect(Item.active).toBe(true);
    expect(Item.status).toBe('ACTIVE');
    expect(typeof Item.assignedAt).toBe('string');
  });

  it('createAssignment generates a unique assignmentId and guards against overwrite', async () => {
    await handler(event('createAssignment', { input: { taskId: 't', userId: 'u1' } }));
    expect(lastInput().Item.assignmentId).toMatch(/[0-9a-f-]{36}/);
    expect(lastInput().ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('createAssignment validates taskId and userId', async () => {
    await expect(handler(event('createAssignment', { input: { userId: 'u1' } }))).rejects.toThrow(
      'taskId is required',
    );
    await expect(handler(event('createAssignment', { input: { taskId: 't' } }))).rejects.toThrow(
      'userId is required',
    );
  });

  it('updateAssignmentStatus updates by key, aliases the reserved word status, and returns the new item', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { assignmentId: 'a1', status: 'COMPLETED', active: false } });
    const result = (await handler(
      event('updateAssignmentStatus', {
        input: { userId: 'u1', assignmentId: 'a1', status: 'COMPLETED', active: false },
      }),
    )) as Assignment;
    const input = lastInput();
    expect(input.Key).toEqual({ PK: 'USER#u1', SK: 'ASSIGN#a1' });
    expect(input.ExpressionAttributeNames['#status']).toBe('status');
    expect(input.UpdateExpression).toContain('#status = :status');
    expect(input.UpdateExpression).toContain('#active = :active');
    expect(input.ConditionExpression).toBe('attribute_exists(PK)');
    expect(result.status).toBe('COMPLETED');
  });

  it('updateAssignmentStatus omits active from the update when not provided', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { assignmentId: 'a1', status: 'PAUSED' } });
    await handler(event('updateAssignmentStatus', { input: { userId: 'u1', assignmentId: 'a1', status: 'PAUSED' } }));
    expect(lastInput().UpdateExpression).not.toContain('#active');
  });

  it('listAssignmentsForUser queries PK=USER#<id> with SK begins_with ASSIGN#', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ assignmentId: 'a1' }] });
    const result = (await handler(event('listAssignmentsForUser', { userId: 'u1' }))) as Connection<unknown>;
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':prefix': 'ASSIGN#' });
    expect(result.items).toHaveLength(1);
  });
});
