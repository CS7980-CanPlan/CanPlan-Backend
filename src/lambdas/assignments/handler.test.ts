import { deriveInstanceStatus, handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { queryAllItems } from '../../shared/batch';
import type {
  Connection,
  TaskAssignment,
  TaskInstance,
  TaskInstanceStep,
  TaskInstanceView,
} from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));
jest.mock('../../shared/batch', () => ({ queryAllItems: jest.fn() }));

const mockSend = dynamo.send as jest.Mock;
const mockQueryAllItems = queryAllItems as jest.Mock;

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose mock helpers

function event(fieldName: string, args: Record<string, unknown>, sub = 'assigner-1') {
  return { arguments: args, info: { fieldName }, identity: { sub } } as Parameters<typeof handler>[0];
}

const inputs = (): Rec[] => mockSend.mock.calls.map((c) => c[0].input);
const byCommand = (name: string): Rec[] =>
  mockSend.mock.calls.filter((c) => c[0].constructor.name === name).map((c) => c[0].input);

/**
 * Route dynamo.send by command type + key. Tests populate `db` to control what each
 * read returns; writes resolve to ALL_NEW echoes of the item being written.
 */
interface DbState {
  assignment?: Rec; // TASK_ASSIGNMENT# GET
  instance?: Rec; // TASK_INSTANCE# GET
  taskMeta?: Rec; // #META GET (title / existence)
  instancesInRange?: Rec[]; // QueryCommand BETWEEN (real instances)
}
let db: DbState = {};

beforeEach(() => {
  db = {};
  mockQueryAllItems.mockResolvedValue([]);
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'GetCommand') {
      const sk: string = input.Key.SK;
      if (sk === '#META') return Promise.resolve({ Item: db.taskMeta });
      if (sk.startsWith('TASK_ASSIGNMENT#')) return Promise.resolve({ Item: db.assignment });
      if (sk.startsWith('TASK_INSTANCE#')) return Promise.resolve({ Item: db.instance });
      return Promise.resolve({});
    }
    if (name === 'QueryCommand') {
      // queryInstancesInRange uses BETWEEN; queryPage list ops use begins_with.
      if (typeof input.KeyConditionExpression === 'string' && input.KeyConditionExpression.includes('BETWEEN')) {
        return Promise.resolve({ Items: db.instancesInRange ?? [] });
      }
      return Promise.resolve({ Items: [] });
    }
    if (name === 'UpdateCommand') {
      // Echo a merged ALL_NEW from the SET values (good enough for presenter assertions).
      return Promise.resolve({ Attributes: { ...(db.instance ?? {}), ...echoUpdate(input) } });
    }
    return Promise.resolve({});
  });
});
afterEach(() => jest.clearAllMocks());

/** Crudely reconstruct an ALL_NEW echo from an UpdateCommand's expression values. */
function echoUpdate(input: Rec): Rec {
  const out: Rec = {};
  const values: Rec = input.ExpressionAttributeValues ?? {};
  if (input.UpdateExpression?.includes('#status = :cancelled')) out.status = values[':cancelled'];
  if (input.UpdateExpression?.includes('#status = :status')) out.status = values[':status'];
  if (input.UpdateExpression?.includes('active = :false')) out.active = false;
  if (values[':instanceId']) out.instanceId = values[':instanceId'];
  if (values[':true'] !== undefined) out.isException = true;
  if (input.UpdateExpression?.includes('endedAt = :now')) out.endedAt = values[':now'];
  if (values[':endDate']) out.endDate = values[':endDate'];
  return out;
}

const RECURRING: TaskAssignment = {
  assignmentId: 'a1',
  taskId: 't1',
  userId: 'u1',
  scheduleType: 'RECURRING',
  scheduleRule: 'FREQ=DAILY;INTERVAL=1',
  startDate: '2099-07-01',
  startTime: '09:00',
  timezone: 'UTC',
  active: true,
  assignedAt: 'x',
  createdAt: 'x',
};

// ── createTaskAssignment ──────────────────────────────────────────────────────
describe('createTaskAssignment', () => {
  it('writes ONLY a TaskAssignment row (no TaskInstances) with the active GSI marker', async () => {
    db.taskMeta = { taskId: 't1', title: 'Take meds' };
    const result = (await handler(
      event('createTaskAssignment', {
        input: {
          taskId: 't1',
          userId: 'u1',
          scheduleType: 'RECURRING',
          scheduleRule: 'FREQ=DAILY',
          startDate: '2099-07-01',
          startTime: '09:00',
          timezone: 'UTC',
        },
      }),
    )) as TaskAssignment;

    // Exactly one Put, and never a TransactWrite (no instances materialized).
    const puts = byCommand('PutCommand');
    expect(puts).toHaveLength(1);
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    const item = puts[0].Item;
    expect(item.SK).toBe(`TASK_ASSIGNMENT#${item.assignmentId}`);
    expect(item.entityType).toBe('TaskAssignment');
    expect(item.active).toBe(true);
    expect(item.activeTaskAssignmentTaskId).toBe('t1'); // sparse GSI marker
    expect(puts[0].ConditionExpression).toBe('attribute_not_exists(PK)');
    // assignedBy defaults to the caller; the GSI marker is stripped from the response.
    expect(result.assignedBy).toBe('assigner-1');
    expect((result as Rec).activeTaskAssignmentTaskId).toBeUndefined();
    expect(result.scheduleType).toBe('RECURRING');
  });

  it('rejects when the referenced task does not exist', async () => {
    db.taskMeta = undefined;
    await expect(
      handler(
        event('createTaskAssignment', {
          input: { taskId: 'gone', userId: 'u1', scheduleType: 'ONE_TIME', scheduledFor: '2026-07-01T09:00:00Z', timezone: 'UTC' },
        }),
      ),
    ).rejects.toThrow('task gone not found');
  });

  it('validates ONE_TIME requires scheduledFor and RECURRING requires a rule', async () => {
    db.taskMeta = { taskId: 't1' };
    await expect(
      handler(event('createTaskAssignment', { input: { taskId: 't1', userId: 'u1', scheduleType: 'ONE_TIME', timezone: 'UTC' } })),
    ).rejects.toThrow('scheduledFor is required');
    await expect(
      handler(event('createTaskAssignment', { input: { taskId: 't1', userId: 'u1', scheduleType: 'RECURRING', startDate: '2099-07-01', startTime: '09:00', timezone: 'UTC' } })),
    ).rejects.toThrow('scheduleRule is required');
  });
});

// ── getTaskInstanceViews ──────────────────────────────────────────────────────
describe('getTaskInstanceViews', () => {
  it('expands virtual recurring occurrences and overlays a real instance', async () => {
    mockQueryAllItems.mockResolvedValue([RECURRING]); // assignments in the user partition
    db.taskMeta = { taskId: 't1', title: 'Take meds' };
    // A real instance already exists for 2099-07-02 (IN_PROGRESS).
    db.instancesInRange = [
      {
        instanceId: 'a1#2099-07-02#09:00',
        assignmentId: 'a1',
        taskId: 't1',
        userId: 'u1',
        scheduledDate: '2099-07-02',
        scheduledTime: '09:00',
        scheduledFor: '2099-07-02T09:00:00.000Z',
        timezone: 'UTC',
        status: 'IN_PROGRESS',
      },
    ];

    const result = (await handler(
      event('getTaskInstanceViews', { userId: 'u1', startDate: '2099-07-01', endDate: '2099-07-03' }),
    )) as Connection<TaskInstanceView>;

    expect(result.items).toHaveLength(3); // one per day
    expect(result.items.map((v) => v.scheduledDate)).toEqual(['2099-07-01', '2099-07-02', '2099-07-03']);
    const overlaid = result.items.find((v) => v.scheduledDate === '2099-07-02')!;
    expect(overlaid.isVirtual).toBe(false);
    expect(overlaid.instanceId).toBe('a1#2099-07-02#09:00');
    expect(overlaid.status).toBe('IN_PROGRESS');
    // The other two days are virtual (no real instance yet).
    const virtual = result.items.find((v) => v.scheduledDate === '2099-07-01')!;
    expect(virtual.isVirtual).toBe(true);
    expect(virtual.instanceId).toBeNull();
    expect(virtual.title).toBe('Take meds');
  });

  it('returns no virtual occurrences for an inactive (ended/deleted) assignment', async () => {
    mockQueryAllItems.mockResolvedValue([{ ...RECURRING, active: false }]);
    db.taskMeta = { taskId: 't1', title: 'Take meds' };
    const result = (await handler(
      event('getTaskInstanceViews', { userId: 'u1', startDate: '2099-07-01', endDate: '2099-07-03' }),
    )) as Connection<TaskInstanceView>;
    expect(result.items).toHaveLength(0);
  });

  it('caps the date-range span', async () => {
    await expect(
      handler(event('getTaskInstanceViews', { userId: 'u1', startDate: '2026-01-01', endDate: '2030-01-01' })),
    ).rejects.toThrow('at most 370 days');
  });
});

// ── startTaskInstance ─────────────────────────────────────────────────────────
describe('startTaskInstance', () => {
  const startArgs = { userId: 'u1', assignmentId: 'a1', scheduledDate: '2099-07-02', scheduledTime: '09:00' };

  it('snapshots the task steps exactly once and sets IN_PROGRESS', async () => {
    db.assignment = RECURRING;
    db.instance = undefined; // does not exist yet
    mockQueryAllItems.mockResolvedValue([
      { stepId: 's1', order: 1, text: 'Wet brush', mediaAssets: [{ assetId: 'm1' }] },
      { stepId: 's2', order: 2, text: 'Add paste' },
    ]);

    const result = (await handler(event('startTaskInstance', { input: startArgs }))) as TaskInstance;

    const tx = byCommand('TransactWriteCommand');
    expect(tx).toHaveLength(1);
    const items = tx[0].TransactItems.map((t: Rec) => t.Put.Item);
    const instance = items.find((i: Rec) => i.entityType === 'TaskInstance')!;
    expect(instance.SK).toBe('TASK_INSTANCE#2099-07-02#09:00#a1');
    expect(instance.status).toBe('IN_PROGRESS');
    expect(instance.startedAt).toBeDefined();
    // Instance Put is guarded so steps snapshot exactly once.
    const instancePut = tx[0].TransactItems.find((t: Rec) => t.Put.Item.entityType === 'TaskInstance');
    expect(instancePut.Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    // One step snapshot per TaskStep, text only (NOT media), completed=false.
    const steps = items.filter((i: Rec) => i.entityType === 'TaskInstanceStep');
    expect(steps).toHaveLength(2);
    expect(steps[0].SK).toBe('TASK_INSTANCE_STEP#a1#2099-07-02#09:00#STEP#s1');
    expect(steps[0].mediaAssets).toBeUndefined();
    expect(steps.every((s: Rec) => s.completed === false)).toBe(true);
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('is idempotent — an existing instance is returned without re-snapshotting steps', async () => {
    db.assignment = RECURRING;
    db.instance = {
      instanceId: 'a1#2099-07-02#09:00',
      assignmentId: 'a1',
      status: 'IN_PROGRESS',
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
    };
    const result = (await handler(event('startTaskInstance', { input: startArgs }))) as TaskInstance;
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    expect(result.instanceId).toBe('a1#2099-07-02#09:00');
  });

  it('rejects an occurrence that the schedule does not produce', async () => {
    db.assignment = RECURRING; // daily at 09:00
    await expect(
      handler(event('startTaskInstance', { input: { ...startArgs, scheduledTime: '10:00' } })),
    ).rejects.toThrow('no occurrence');
  });
});

// ── setTaskInstanceStepCompletion ─────────────────────────────────────────────
describe('setTaskInstanceStepCompletion', () => {
  const args = { userId: 'u1', instanceId: 'a1#2099-07-02#09:00', stepId: 's1', completed: true };

  it('toggles a step complete on a non-terminal instance, stamping completedAt', async () => {
    db.instance = { status: 'IN_PROGRESS' };
    mockSend.mockImplementationOnce(() => Promise.resolve({ Item: db.instance })); // getInstance
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ Attributes: { stepId: 's1', completed: true, completedAt: 'now' } }),
    );
    const result = (await handler(event('setTaskInstanceStepCompletion', { input: args }))) as TaskInstanceStep;
    const update = byCommand('UpdateCommand')[0];
    expect(update.Key.SK).toBe('TASK_INSTANCE_STEP#a1#2099-07-02#09:00#STEP#s1');
    expect(update.UpdateExpression).toContain('completedAt = :completedAt');
    expect(result.completed).toBe(true);
  });

  it('rejects toggling a step on a terminal (COMPLETED) instance', async () => {
    db.instance = { status: 'COMPLETED' };
    await expect(handler(event('setTaskInstanceStepCompletion', { input: args }))).rejects.toThrow(
      'cannot change step completion on a COMPLETED instance',
    );
    expect(byCommand('UpdateCommand')).toHaveLength(0);
  });

  it('404s when the instance does not exist', async () => {
    db.instance = undefined;
    await expect(handler(event('setTaskInstanceStepCompletion', { input: args }))).rejects.toThrow(
      'task instance a1#2099-07-02#09:00 not found',
    );
  });
});

// ── updateTaskInstanceStatus ──────────────────────────────────────────────────
describe('updateTaskInstanceStatus', () => {
  const base = { userId: 'u1', instanceId: 'a1#2099-07-02#09:00' };

  it('completes a non-terminal instance only when every step is complete, clearing skippedAt', async () => {
    db.instance = { status: 'IN_PROGRESS' };
    mockQueryAllItems.mockResolvedValue([{ completed: true }, { completed: true }]);
    const result = (await handler(
      event('updateTaskInstanceStatus', { input: { ...base, status: 'COMPLETED' } }),
    )) as TaskInstance;
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('completedAt = :now');
    // A status change never leaves a stale opposite-terminal timestamp behind.
    expect(update.UpdateExpression).toContain('REMOVE skippedAt');
    expect(result.status).toBe('COMPLETED');
  });

  it('clears completedAt/skippedAt when moving to IN_PROGRESS', async () => {
    db.instance = { status: 'IN_PROGRESS' };
    await handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'IN_PROGRESS' } }));
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('startedAt = if_not_exists(startedAt, :now)');
    expect(update.UpdateExpression).toContain('REMOVE completedAt, skippedAt');
  });

  it('rejects COMPLETED while a step is incomplete', async () => {
    db.instance = { status: 'IN_PROGRESS' };
    mockQueryAllItems.mockResolvedValue([{ completed: true }, { completed: false }]);
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'COMPLETED' } })),
    ).rejects.toThrow('one or more steps are incomplete');
    expect(byCommand('UpdateCommand')).toHaveLength(0);
  });

  it('rejects changing the status of a terminal (COMPLETED) instance — no rewinding', async () => {
    db.instance = { status: 'COMPLETED' };
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'IN_PROGRESS' } })),
    ).rejects.toThrow('cannot change status of a COMPLETED instance');
    expect(byCommand('UpdateCommand')).toHaveLength(0);
  });

  it('404s when the instance does not exist', async () => {
    db.instance = undefined;
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'SKIPPED' } })),
    ).rejects.toThrow('task instance a1#2099-07-02#09:00 not found');
  });

  it('rejects the derived OVERDUE status and CANCELLED before any read', async () => {
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'OVERDUE' } })),
    ).rejects.toThrow('OVERDUE is a derived status');
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'CANCELLED' } })),
    ).rejects.toThrow('use cancelTaskInstance');
  });
});

// ── cancelTaskInstance ────────────────────────────────────────────────────────
describe('cancelTaskInstance', () => {
  const cancelArgs = { userId: 'u1', assignmentId: 'a1', scheduledDate: '2099-07-02', scheduledTime: '09:00' };

  it('writes a CANCELLED exception for a virtual occurrence (upsert)', async () => {
    db.assignment = RECURRING;
    db.instance = undefined; // no real row yet — a virtual slot
    const result = (await handler(
      event('cancelTaskInstance', { input: cancelArgs }),
    )) as TaskInstance;
    const update = byCommand('UpdateCommand')[0];
    expect(update.Key.SK).toBe('TASK_INSTANCE#2099-07-02#09:00#a1');
    expect(update.ExpressionAttributeValues[':cancelled']).toBe('CANCELLED');
    expect(update.ExpressionAttributeValues[':true']).toBe(true);
    expect(update.UpdateExpression).toContain('if_not_exists(createdAt');
    // No stale lifecycle timestamp survives the transition.
    expect(update.UpdateExpression).toContain('REMOVE completedAt, skippedAt');
    expect(result.status).toBe('CANCELLED');
    expect(result.isException).toBe(true);
  });

  it('rejects cancelling a terminal (COMPLETED) instance and issues no write', async () => {
    db.assignment = RECURRING;
    db.instance = {
      instanceId: 'a1#2099-07-02#09:00', status: 'COMPLETED',
      scheduledDate: '2099-07-02', scheduledTime: '09:00', completedAt: 'earlier',
    };
    await expect(handler(event('cancelTaskInstance', { input: cancelArgs }))).rejects.toThrow(
      'cannot cancel a COMPLETED instance',
    );
    expect(byCommand('UpdateCommand')).toHaveLength(0);
  });

  it('cancels an existing IN_PROGRESS instance (non-terminal)', async () => {
    db.assignment = RECURRING;
    db.instance = {
      instanceId: 'a1#2099-07-02#09:00', status: 'IN_PROGRESS',
      scheduledDate: '2099-07-02', scheduledTime: '09:00', startedAt: 'earlier',
    };
    const result = (await handler(event('cancelTaskInstance', { input: cancelArgs }))) as TaskInstance;
    expect(byCommand('UpdateCommand')).toHaveLength(1);
    expect(result.status).toBe('CANCELLED');
    expect(result.isException).toBe(true);
  });
});

// ── endTaskAssignment / deleteTaskAssignment ──────────────────────────────────
describe('end / delete assignment prevents future virtual instances', () => {
  it('endTaskAssignment fully ends a ONE_TIME assignment (active=false, GSI marker removed)', async () => {
    db.assignment = {
      assignmentId: 'a1', taskId: 't1', userId: 'u1', scheduleType: 'ONE_TIME',
      scheduledFor: '2099-07-02T09:00:00Z', timezone: 'UTC', active: true, assignedAt: 'x', createdAt: 'x',
    };
    await handler(event('endTaskAssignment', { input: { userId: 'u1', assignmentId: 'a1', effectiveDate: '2099-07-02' } }));
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('active = :false');
    expect(update.UpdateExpression).toContain('REMOVE activeTaskAssignmentTaskId');
  });

  it('endTaskAssignment caps endDate but keeps a RECURRING assignment active when days remain', async () => {
    db.assignment = RECURRING; // starts 2026-07-01
    await handler(event('endTaskAssignment', { input: { userId: 'u1', assignmentId: 'a1', effectiveDate: '2099-07-10' } }));
    const update = byCommand('UpdateCommand')[0];
    expect(update.ExpressionAttributeValues[':endDate']).toBe('2099-07-09'); // day before
    expect(update.UpdateExpression).not.toContain('active = :false');
  });

  it('endTaskAssignment preserves an existing endDate earlier than the computed one (never extends)', async () => {
    db.assignment = { ...RECURRING, endDate: '2099-07-05' };
    await handler(event('endTaskAssignment', { input: { userId: 'u1', assignmentId: 'a1', effectiveDate: '2099-07-10' } }));
    const update = byCommand('UpdateCommand')[0];
    // newEndDate would be 2099-07-09, but the earlier 2099-07-05 wins — the window is not pushed out.
    expect(update.ExpressionAttributeValues[':endDate']).toBe('2099-07-05');
    expect(update.UpdateExpression).not.toContain('active = :false');
  });

  it('endTaskAssignment shortens an existing endDate later than the computed one', async () => {
    db.assignment = { ...RECURRING, endDate: '2099-07-20' };
    await handler(event('endTaskAssignment', { input: { userId: 'u1', assignmentId: 'a1', effectiveDate: '2099-07-10' } }));
    const update = byCommand('UpdateCommand')[0];
    expect(update.ExpressionAttributeValues[':endDate']).toBe('2099-07-09'); // shortened to day before
  });

  it('deleteTaskAssignment soft-deletes (active=false, endedAt, GSI marker removed)', async () => {
    const result = (await handler(
      event('deleteTaskAssignment', { input: { userId: 'u1', assignmentId: 'a1' } }),
    )) as TaskAssignment;
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('active = :false');
    expect(update.UpdateExpression).toContain('endedAt = :now');
    expect(update.UpdateExpression).toContain('REMOVE activeTaskAssignmentTaskId');
    expect(update.ConditionExpression).toBe('attribute_exists(PK)');
    expect(result.active).toBe(false);
  });

  it('deleteTaskAssignment 404s when the assignment is missing', async () => {
    mockSend.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })),
    );
    await expect(
      handler(event('deleteTaskAssignment', { input: { userId: 'u1', assignmentId: 'gone' } })),
    ).rejects.toThrow('assignment gone not found');
  });
});

// ── listTaskAssignmentsForUser ────────────────────────────────────────────────
describe('listTaskAssignmentsForUser', () => {
  it('queries the TASK_ASSIGNMENT# prefix and strips the GSI marker', async () => {
    mockSend.mockImplementation(() =>
      Promise.resolve({ Items: [{ assignmentId: 'a1', active: true, activeTaskAssignmentTaskId: 't1' }] }),
    );
    const result = (await handler(
      event('listTaskAssignmentsForUser', { userId: 'u1' }),
    )) as Connection<TaskAssignment>;
    expect(inputs()[0].ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':prefix': 'TASK_ASSIGNMENT#' });
    expect(result.items).toHaveLength(1);
    expect((result.items[0] as Rec).activeTaskAssignmentTaskId).toBeUndefined();
  });
});

// ── routing + pure helper ─────────────────────────────────────────────────────
describe('routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});

describe('deriveInstanceStatus', () => {
  const now = Date.parse('2026-06-20T00:00:00.000Z');
  it('returns OVERDUE only for non-terminal past occurrences', () => {
    expect(deriveInstanceStatus('TO_DO', '2026-06-19T00:00:00.000Z', now)).toBe('OVERDUE');
    expect(deriveInstanceStatus('IN_PROGRESS', '2026-06-19T00:00:00.000Z', now)).toBe('OVERDUE');
    expect(deriveInstanceStatus('TO_DO', '2026-06-21T00:00:00.000Z', now)).toBe('TO_DO');
    expect(deriveInstanceStatus('COMPLETED', '2000-01-01T00:00:00.000Z', now)).toBe('COMPLETED');
    expect(deriveInstanceStatus('CANCELLED', '2000-01-01T00:00:00.000Z', now)).toBe('CANCELLED');
  });
});
