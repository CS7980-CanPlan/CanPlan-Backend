import { deriveStatus, handler, normalizePersistedStatus } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { Assignment, AssignmentStep, Connection } from '../../shared/types';

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

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose mock-inspection helpers

/** The params of every DynamoDB command the handler issued, in order. */
const inputs = (): Rec[] => mockSend.mock.calls.map((c) => c[0].input);
/** The single TransactWrite's items (createAssignment writes assignment + steps atomically). */
const transactItems = (): Rec[] =>
  inputs()
    .find((i) => i.TransactItems)!
    .TransactItems.map((t: { Put: { Item: Rec } }) => t.Put.Item);
const updateInput = (): Rec => inputs().find((i) => i.UpdateExpression)!;

// ── createAssignment ──────────────────────────────────────────────────────────
describe('createAssignment', () => {
  // task GET → steps QUERY → TransactWrite
  const stubTask = (steps: Array<Record<string, unknown>> = []) =>
    mockSend
      .mockResolvedValueOnce({ Item: { taskId: 'task-1' } })
      .mockResolvedValueOnce({ Items: steps })
      .mockResolvedValueOnce({});

  it('writes the Assignment under USER#<userId> / ASSIGN#<assignmentId> with persisted status TO_DO', async () => {
    stubTask();
    const result = (await handler(
      event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } }),
    )) as Assignment;

    const assignment = transactItems().find((i) => i.entityType === 'Assignment')!;
    expect(assignment.PK).toBe('USER#u1');
    expect(assignment.SK).toBe(`ASSIGN#${assignment.assignmentId}`);
    expect(assignment.SK).not.toBe('ASSIGN#task-1');
    expect(assignment.taskId).toBe('task-1');
    expect(assignment.status).toBe('TO_DO');
    expect(result.status).toBe('TO_DO');
    expect(result.assignmentId).toBe(assignment.assignmentId);
    // No `active` field is written or returned anymore.
    expect(assignment.active).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).active).toBeUndefined();
  });

  it('guards the assignment row against overwrite', async () => {
    stubTask();
    await handler(event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } }));
    const assignment = transactItems().find((i) => i.entityType === 'Assignment')!;
    // ConditionExpression rides on the Put op, not the item itself.
    const transact = inputs().find((i) => i.TransactItems)!;
    const assignmentPut = transact.TransactItems.find(
      (t: { Put: { Item: { entityType: string } } }) => t.Put.Item.entityType === 'Assignment',
    );
    expect(assignmentPut.Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(assignment.assignmentId).toMatch(/[0-9a-f-]{36}/);
  });

  it('snapshots one AssignmentStep per TaskStep, copying text only (NOT media) and completed=false', async () => {
    stubTask([
      // The TaskStep may carry live media assets — they must NOT be copied into the snapshot.
      { stepId: 's1', taskId: 'task-1', order: 1, text: 'Wet brush', mediaAssets: [{ assetId: 'm1' }] },
      { stepId: 's2', taskId: 'task-1', order: 2, text: 'Add paste' },
    ]);
    await handler(event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } }));

    const steps = transactItems().filter((i) => i.entityType === 'AssignmentStep');
    expect(steps).toHaveLength(2);
    const s1 = steps.find((s) => s.stepId === 's1')!;
    expect(s1.PK).toBe('USER#u1');
    expect(s1.SK).toBe(`ASSIGN_STEP#${steps[0].assignmentId}#STEP#s1`);
    expect(s1.order).toBe(1);
    expect(s1.text).toBe('Wet brush');
    // A live Task MediaAsset is never copied into an immutable assignment snapshot.
    expect(s1.mediaAssets).toBeUndefined();
    expect(s1.completed).toBe(false);
    expect(s1.completedAt).toBeUndefined();
    expect(typeof s1.createdAt).toBe('string');
    expect(steps.every((s) => s.completed === false)).toBe(true);
  });

  it('supports assigning the same task to the same user repeatedly (unique assignmentIds)', async () => {
    stubTask();
    const a = (await handler(
      event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } }),
    )) as Assignment;
    mockSend.mockReset();
    stubTask();
    const b = (await handler(
      event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } }),
    )) as Assignment;
    expect(a.assignmentId).not.toBe(b.assignmentId);
  });

  it('rejects when the referenced task does not exist', async () => {
    mockSend.mockResolvedValueOnce({}); // task GET → no Item
    await expect(
      handler(event('createAssignment', { input: { taskId: 'missing', userId: 'u1' } })),
    ).rejects.toThrow('task missing not found');
  });

  it('rejects a task with more steps than the transaction limit allows', async () => {
    const tooMany = Array.from({ length: 100 }, (_, i) => ({ stepId: `s${i}`, order: i + 1, text: 't' }));
    mockSend.mockResolvedValueOnce({ Item: { taskId: 'task-1' } }).mockResolvedValueOnce({ Items: tooMany });
    await expect(
      handler(event('createAssignment', { input: { taskId: 'task-1', userId: 'u1' } })),
    ).rejects.toThrow('at most 99 steps');
  });

  it('validates taskId and userId', async () => {
    await expect(handler(event('createAssignment', { input: { userId: 'u1' } }))).rejects.toThrow(
      'taskId is required',
    );
    await expect(handler(event('createAssignment', { input: { taskId: 't' } }))).rejects.toThrow(
      'userId is required',
    );
  });
});

// ── updateAssignmentStatus ──────────────────────────────────────────────────--
describe('updateAssignmentStatus', () => {
  it('persists TO_DO/COMPLETED/SKIPPED, aliases the reserved word status, and returns the new item', async () => {
    // COMPLETED first loads steps (all complete), then updates.
    mockSend
      .mockResolvedValueOnce({ Items: [{ completed: true }] })
      .mockResolvedValueOnce({ Attributes: { assignmentId: 'a1', status: 'COMPLETED' } });
    const result = (await handler(
      event('updateAssignmentStatus', { input: { userId: 'u1', assignmentId: 'a1', status: 'COMPLETED' } }),
    )) as Assignment;
    const input = updateInput();
    expect(input.Key).toEqual({ PK: 'USER#u1', SK: 'ASSIGN#a1' });
    expect(input.ExpressionAttributeNames['#status']).toBe('status');
    expect(input.UpdateExpression).toContain('#status = :status');
    expect(input.ConditionExpression).toBe('attribute_exists(PK)');
    expect(result.status).toBe('COMPLETED');
  });

  it('rejects an attempt to persist the derived OVERDUE status', async () => {
    await expect(
      handler(event('updateAssignmentStatus', { input: { userId: 'u1', assignmentId: 'a1', status: 'OVERDUE' } })),
    ).rejects.toThrow('OVERDUE is a derived status');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects COMPLETED while any step is incomplete', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ completed: true }, { completed: false }] });
    await expect(
      handler(event('updateAssignmentStatus', { input: { userId: 'u1', assignmentId: 'a1', status: 'COMPLETED' } })),
    ).rejects.toThrow('one or more steps are incomplete');
    // It never reached the UpdateCommand.
    expect(inputs().some((i) => i.UpdateExpression)).toBe(false);
  });

  it('allows COMPLETED for a zero-step assignment', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Attributes: { assignmentId: 'a1', status: 'COMPLETED' } });
    const result = (await handler(
      event('updateAssignmentStatus', { input: { userId: 'u1', assignmentId: 'a1', status: 'COMPLETED' } }),
    )) as Assignment;
    expect(result.status).toBe('COMPLETED');
  });

  it('does not check steps when setting SKIPPED', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { assignmentId: 'a1', status: 'SKIPPED' } });
    const result = (await handler(
      event('updateAssignmentStatus', { input: { userId: 'u1', assignmentId: 'a1', status: 'SKIPPED' } }),
    )) as Assignment;
    expect(result.status).toBe('SKIPPED');
    expect(mockSend).toHaveBeenCalledTimes(1); // update only, no step load
  });
});

// ── setAssignmentStepCompletion ─────────────────────────────────────────────--
describe('setAssignmentStepCompletion', () => {
  it('marks a step complete, stamping completedAt', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { status: 'TO_DO' } })
      .mockResolvedValueOnce({ Attributes: { stepId: 's1', completed: true, completedAt: 'now' } });
    const result = (await handler(
      event('setAssignmentStepCompletion', {
        input: { userId: 'u1', assignmentId: 'a1', stepId: 's1', completed: true },
      }),
    )) as AssignmentStep;
    const input = updateInput();
    expect(input.Key).toEqual({ PK: 'USER#u1', SK: 'ASSIGN_STEP#a1#STEP#s1' });
    expect(input.UpdateExpression).toContain('completedAt = :completedAt');
    expect(input.ExpressionAttributeValues[':completed']).toBe(true);
    expect(result.completed).toBe(true);
  });

  it('removes completedAt when marking a step incomplete', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { status: 'TO_DO' } })
      .mockResolvedValueOnce({ Attributes: { stepId: 's1', completed: false } });
    await handler(
      event('setAssignmentStepCompletion', {
        input: { userId: 'u1', assignmentId: 'a1', stepId: 's1', completed: false },
      }),
    );
    const input = updateInput();
    expect(input.UpdateExpression).toContain('REMOVE completedAt');
    expect(input.ExpressionAttributeValues[':completedAt']).toBeUndefined();
  });

  it('rejects updating a step of a COMPLETED assignment', async () => {
    mockSend.mockResolvedValueOnce({ Item: { status: 'COMPLETED' } });
    await expect(
      handler(
        event('setAssignmentStepCompletion', {
          input: { userId: 'u1', assignmentId: 'a1', stepId: 's1', completed: true },
        }),
      ),
    ).rejects.toThrow('cannot change step completion on a COMPLETED assignment');
    expect(inputs().some((i) => i.UpdateExpression)).toBe(false);
  });

  it('rejects updating a step of a SKIPPED assignment', async () => {
    mockSend.mockResolvedValueOnce({ Item: { status: 'SKIPPED' } });
    await expect(
      handler(
        event('setAssignmentStepCompletion', {
          input: { userId: 'u1', assignmentId: 'a1', stepId: 's1', completed: true },
        }),
      ),
    ).rejects.toThrow('SKIPPED assignment');
  });

  it('maps legacy CANCELLED to SKIPPED and rejects step updates', async () => {
    mockSend.mockResolvedValueOnce({ Item: { status: 'CANCELLED' } });
    await expect(
      handler(
        event('setAssignmentStepCompletion', {
          input: { userId: 'u1', assignmentId: 'a1', stepId: 's1', completed: true },
        }),
      ),
    ).rejects.toThrow('SKIPPED assignment');
  });

  it('404s when the assignment does not exist', async () => {
    mockSend.mockResolvedValueOnce({}); // assignment GET → no Item
    await expect(
      handler(
        event('setAssignmentStepCompletion', {
          input: { userId: 'u1', assignmentId: 'gone', stepId: 's1', completed: true },
        }),
      ),
    ).rejects.toThrow('assignment gone not found');
  });

  it('404s when the step does not belong to the assignment', async () => {
    const condFail = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
    mockSend.mockResolvedValueOnce({ Item: { status: 'TO_DO' } }).mockRejectedValueOnce(condFail);
    await expect(
      handler(
        event('setAssignmentStepCompletion', {
          input: { userId: 'u1', assignmentId: 'a1', stepId: 'nope', completed: true },
        }),
      ),
    ).rejects.toThrow('step nope not found');
  });
});

// ── deleteAssignment ────────────────────────────────────────────────────────--
describe('deleteAssignment', () => {
  const stored = { PK: 'USER#u1', SK: 'ASSIGN#a1', entityType: 'Assignment', assignmentId: 'a1', taskId: 't1', userId: 'u1', status: 'TO_DO' };
  const batchInputs = () => inputs().filter((i) => i.RequestItems);
  const deleteRowInputs = () => inputs().filter((i) => i.Key && i.ConditionExpression && !i.UpdateExpression);

  it('deletes the assignment and all of its AssignmentSteps (steps first, row last)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...stored } }) // GET assignment
      .mockResolvedValueOnce({ Items: [{ PK: 'USER#u1', SK: 'ASSIGN_STEP#a1#STEP#s1' }, { PK: 'USER#u1', SK: 'ASSIGN_STEP#a1#STEP#s2' }] })
      .mockResolvedValueOnce({}) // BatchWrite
      .mockResolvedValueOnce({}); // Delete assignment

    const result = (await handler(
      event('deleteAssignment', { input: { userId: 'u1', assignmentId: 'a1' } }),
    )) as Assignment;

    // Step snapshots scoped to this assignment only.
    const stepQuery = inputs().find((i) => i.KeyConditionExpression)!;
    expect(stepQuery.ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':prefix': 'ASSIGN_STEP#a1#STEP#' });
    // One batch carrying both step keys.
    expect(batchInputs()[0].RequestItems['CanPlan-test']).toHaveLength(2);
    // The assignment row delete is the last call.
    const lastCall = mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input;
    expect(lastCall.Key).toEqual({ PK: 'USER#u1', SK: 'ASSIGN#a1' });
    expect(lastCall.ConditionExpression).toBe('attribute_exists(PK)');
    // Returned deleted assignment, internal fields stripped.
    expect(result.assignmentId).toBe('a1');
    const out = result as unknown as Record<string, unknown>;
    expect(out.PK).toBeUndefined();
    expect(out.SK).toBeUndefined();
    expect(out.entityType).toBeUndefined();
  });

  it('returns NotFound and writes nothing when the assignment does not exist', async () => {
    mockSend.mockResolvedValueOnce({}); // GET → no Item
    await expect(
      handler(event('deleteAssignment', { input: { userId: 'u1', assignmentId: 'gone' } })),
    ).rejects.toThrow('assignment gone not found for user u1');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('never modifies the source Task or its TaskSteps (no TASK# key)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...stored } })
      .mockResolvedValueOnce({ Items: [{ PK: 'USER#u1', SK: 'ASSIGN_STEP#a1#STEP#s1' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await handler(event('deleteAssignment', { input: { userId: 'u1', assignmentId: 'a1' } }));
    expect(JSON.stringify(inputs())).not.toContain('TASK#');
  });

  it('deletes >99 step snapshots across query pages in batches of 25', async () => {
    const page = (n: number, last?: boolean) => ({
      Items: Array.from({ length: n }, (_, i) => ({ PK: 'USER#u1', SK: `ASSIGN_STEP#a1#STEP#${i}` })),
      LastEvaluatedKey: last ? undefined : { PK: 'USER#u1', SK: 'last' },
    });
    mockSend
      .mockResolvedValueOnce({ Item: { ...stored } }) // GET assignment
      .mockResolvedValueOnce(page(70)) // step page 1 (more)
      .mockResolvedValueOnce(page(70, true)) // step page 2 (last)
      .mockResolvedValue({}); // BatchWrites + final Delete
    await handler(event('deleteAssignment', { input: { userId: 'u1', assignmentId: 'a1' } }));

    // 140 keys / 25 → 6 BatchWrite calls; row deleted once afterward.
    expect(batchInputs()).toHaveLength(6);
    expect(batchInputs().reduce((n, i) => n + i.RequestItems['CanPlan-test'].length, 0)).toBe(140);
    expect(deleteRowInputs()).toHaveLength(1);
  });

  it('validates userId and assignmentId', async () => {
    await expect(handler(event('deleteAssignment', { input: { assignmentId: 'a1' } }))).rejects.toThrow(
      'userId is required',
    );
    await expect(handler(event('deleteAssignment', { input: { userId: 'u1' } }))).rejects.toThrow(
      'assignmentId is required',
    );
  });

  it('exposes no API for deleting an AssignmentStep independently', async () => {
    await expect(
      handler(event('deleteAssignmentStep', { input: { userId: 'u1', assignmentId: 'a1', stepId: 's1' } })),
    ).rejects.toThrow('unsupported field');
  });
});

// ── listAssignmentsForUser (status derivation + legacy mapping) ──────────────--
describe('listAssignmentsForUser', () => {
  const PAST = '2000-01-01T00:00:00.000Z';
  const FUTURE = '2999-01-01T00:00:00.000Z';

  it('queries the ASSIGN# prefix (which excludes ASSIGN_STEP# rows)', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ assignmentId: 'a1', status: 'TO_DO' }] });
    const result = (await handler(
      event('listAssignmentsForUser', { userId: 'u1' }),
    )) as Connection<Assignment>;
    expect(updateInputOrQuery().ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':prefix': 'ASSIGN#' });
    expect(result.items).toHaveLength(1);
  });

  it('derives OVERDUE for a TO_DO assignment whose dueDate is in the past', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ assignmentId: 'a1', status: 'TO_DO', dueDate: PAST }] });
    const result = (await handler(event('listAssignmentsForUser', { userId: 'u1' }))) as Connection<Assignment>;
    expect(result.items[0].status).toBe('OVERDUE');
  });

  it('does not mark a TO_DO assignment OVERDUE when dueDate is in the future or absent', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { assignmentId: 'a1', status: 'TO_DO', dueDate: FUTURE },
        { assignmentId: 'a2', status: 'TO_DO' },
      ],
    });
    const result = (await handler(event('listAssignmentsForUser', { userId: 'u1' }))) as Connection<Assignment>;
    expect(result.items.map((a) => a.status)).toEqual(['TO_DO', 'TO_DO']);
  });

  it('never marks a COMPLETED assignment OVERDUE, even with a past dueDate', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ assignmentId: 'a1', status: 'COMPLETED', dueDate: PAST }] });
    const result = (await handler(event('listAssignmentsForUser', { userId: 'u1' }))) as Connection<Assignment>;
    expect(result.items[0].status).toBe('COMPLETED');
  });

  it('maps legacy statuses on read (ACTIVE/PAUSED→TO_DO, CANCELLED→SKIPPED) and strips active', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { assignmentId: 'a1', status: 'ACTIVE', active: true },
        { assignmentId: 'a2', status: 'PAUSED' },
        { assignmentId: 'a3', status: 'CANCELLED' },
        { assignmentId: 'a4', status: 'COMPLETED' },
      ],
    });
    const result = (await handler(event('listAssignmentsForUser', { userId: 'u1' }))) as Connection<Assignment>;
    expect(result.items.map((a) => a.status)).toEqual(['TO_DO', 'TO_DO', 'SKIPPED', 'COMPLETED']);
    expect((result.items[0] as unknown as Record<string, unknown>).active).toBeUndefined();
  });
});

// ── listAssignmentSteps ─────────────────────────────────────────────────────--
describe('listAssignmentSteps', () => {
  it('queries only one assignment\'s step rows and returns them sorted by order', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { stepId: 's3', order: 3 },
        { stepId: 's1', order: 1 },
        { stepId: 's2', order: 2 },
      ],
    });
    const result = (await handler(
      event('listAssignmentSteps', { userId: 'u1', assignmentId: 'a1' }),
    )) as Connection<AssignmentStep>;
    expect(updateInputOrQuery().ExpressionAttributeValues).toEqual({
      ':pk': 'USER#u1',
      ':prefix': 'ASSIGN_STEP#a1#STEP#',
    });
    expect(result.items.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('passes limit/nextToken through to the paginated query', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { PK: 'x' } });
    const result = (await handler(
      event('listAssignmentSteps', { userId: 'u1', assignmentId: 'a1', limit: 2 }),
    )) as Connection<AssignmentStep>;
    expect(updateInputOrQuery().Limit).toBe(2);
    expect(result.nextToken).not.toBeNull();
  });

  it('validates userId and assignmentId', async () => {
    await expect(handler(event('listAssignmentSteps', { assignmentId: 'a1' }))).rejects.toThrow(
      'userId is required',
    );
    await expect(handler(event('listAssignmentSteps', { userId: 'u1' }))).rejects.toThrow(
      'assignmentId is required',
    );
  });
});

// queryPage wraps the params in a QueryCommand; grab its input.
function updateInputOrQuery(): Rec {
  return inputs().find((i) => i.KeyConditionExpression)!;
}

// ── pure status helpers ─────────────────────────────────────────────────────--
describe('status helpers', () => {
  it('normalizePersistedStatus maps legacy + valid values, defaulting to TO_DO', () => {
    expect(normalizePersistedStatus('ACTIVE')).toBe('TO_DO');
    expect(normalizePersistedStatus('PAUSED')).toBe('TO_DO');
    expect(normalizePersistedStatus('CANCELLED')).toBe('SKIPPED');
    expect(normalizePersistedStatus('COMPLETED')).toBe('COMPLETED');
    expect(normalizePersistedStatus('TO_DO')).toBe('TO_DO');
    expect(normalizePersistedStatus('SKIPPED')).toBe('SKIPPED');
    expect(normalizePersistedStatus(undefined)).toBe('TO_DO');
  });

  it('deriveStatus only returns OVERDUE for TO_DO + past dueDate', () => {
    const now = Date.parse('2026-06-20T00:00:00.000Z');
    expect(deriveStatus('TO_DO', '2026-06-19T00:00:00.000Z', now)).toBe('OVERDUE');
    expect(deriveStatus('TO_DO', '2026-06-21T00:00:00.000Z', now)).toBe('TO_DO');
    expect(deriveStatus('TO_DO', undefined, now)).toBe('TO_DO');
    expect(deriveStatus('COMPLETED', '2000-01-01T00:00:00.000Z', now)).toBe('COMPLETED');
    expect(deriveStatus('SKIPPED', '2000-01-01T00:00:00.000Z', now)).toBe('SKIPPED');
  });
});
