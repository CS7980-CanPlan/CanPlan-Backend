import { deriveInstanceStatus, handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { queryAllItems } from '../../shared/batch';
import { assertCanActForUser } from '../../shared/delegation';
import { UnauthorizedError } from '../../shared/response';
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
// Delegated-access authorization is unit-tested in shared/delegation.test.ts; here it is mocked
// to resolve by default (caller may act for the target), so each test can exercise the
// scheduling logic. Specific tests override it to assert it is invoked / that a denial blocks.
jest.mock('../../shared/delegation', () => ({ assertCanActForUser: jest.fn() }));

const mockSend = dynamo.send as jest.Mock;
const mockQueryAllItems = queryAllItems as jest.Mock;
const mockAssertCanAct = assertCanActForUser as jest.Mock;

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
  steps?: Record<string, Rec>; // TASK_INSTANCE_STEP# GET, keyed by stepId
}
let db: DbState = {};

beforeEach(() => {
  db = {};
  mockQueryAllItems.mockResolvedValue([]);
  // Default: the caller is allowed to act for the target user (self or active delegation).
  mockAssertCanAct.mockResolvedValue('assigner-1');
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'GetCommand') {
      const sk: string = input.Key.SK;
      if (sk === '#META') return Promise.resolve({ Item: db.taskMeta });
      if (sk.startsWith('TASK_ASSIGNMENT#')) return Promise.resolve({ Item: db.assignment });
      // TASK_INSTANCE_STEP# must be checked before TASK_INSTANCE# (the latter is not a prefix of it).
      if (sk.startsWith('TASK_INSTANCE_STEP#')) {
        const stepId = sk.split('#STEP#')[1];
        return Promise.resolve({ Item: db.steps?.[stepId] });
      }
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
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

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
    // The caller must own the referenced template (a SupportPerson schedules their own task).
    db.taskMeta = { taskId: 't1', title: 'Take meds', ownerId: 'assigner-1' };
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

    // The caller's right to act for the target user was checked.
    expect(mockAssertCanAct).toHaveBeenCalledWith(expect.objectContaining({ sub: 'assigner-1' }), 'u1');
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
    // assignedBy is the caller's identity; the GSI marker is stripped from the response.
    expect(result.assignedBy).toBe('assigner-1');
    expect((result as Rec).activeTaskAssignmentTaskId).toBeUndefined();
    expect(result.scheduleType).toBe('RECURRING');
  });

  it('derives assignedBy from the caller identity, ignoring a client-supplied assignedBy', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'assigner-1' };
    const result = (await handler(
      event('createTaskAssignment', {
        input: {
          taskId: 't1',
          userId: 'u1',
          assignedBy: 'victim', // must be ignored
          scheduleType: 'ONE_TIME',
          scheduledFor: '2099-07-01T09:00:00Z',
          timezone: 'UTC',
        },
      }),
    )) as TaskAssignment;
    expect(result.assignedBy).toBe('assigner-1'); // not 'victim'
    expect(byCommand('PutCommand')[0].Item.assignedBy).toBe('assigner-1');
  });

  it('rejects creating an assignment with a template the caller does not own', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'someone-else' };
    await expect(
      handler(
        event('createTaskAssignment', {
          input: { taskId: 't1', userId: 'u1', scheduleType: 'ONE_TIME', scheduledFor: '2099-07-01T09:00:00Z', timezone: 'UTC' },
        }),
      ),
    ).rejects.toThrow('does not own this resource');
    expect(byCommand('PutCommand')).toHaveLength(0);
  });

  it('rejects when the caller may not act for the target user (delegation denied)', async () => {
    mockAssertCanAct.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    db.taskMeta = { taskId: 't1', ownerId: 'assigner-1' };
    await expect(
      handler(
        event('createTaskAssignment', {
          input: { taskId: 't1', userId: 'u1', scheduleType: 'ONE_TIME', scheduledFor: '2099-07-01T09:00:00Z', timezone: 'UTC' },
        }),
      ),
    ).rejects.toThrow('no active support link');
    expect(byCommand('PutCommand')).toHaveLength(0);
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
    db.taskMeta = { taskId: 't1', ownerId: 'assigner-1' };
    await expect(
      handler(event('createTaskAssignment', { input: { taskId: 't1', userId: 'u1', scheduleType: 'ONE_TIME', timezone: 'UTC' } })),
    ).rejects.toThrow('scheduledFor is required');
    await expect(
      handler(event('createTaskAssignment', { input: { taskId: 't1', userId: 'u1', scheduleType: 'RECURRING', startDate: '2099-07-01', startTime: '09:00', timezone: 'UTC' } })),
    ).rejects.toThrow('scheduleRule is required');
  });
});

describe('delegated authorization on schedule operations', () => {
  it('blocks startTaskInstance when the caller may not act for the user', async () => {
    mockAssertCanAct.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    db.assignment = RECURRING;
    await expect(
      handler(
        event('startTaskInstance', {
          input: { userId: 'u1', assignmentId: 'a1', scheduledDate: '2099-07-02', scheduledTime: '09:00' },
        }),
      ),
    ).rejects.toThrow('no active support link');
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
  });

  it('blocks listTaskAssignmentsForUser when the caller may not act for the user', async () => {
    mockAssertCanAct.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(handler(event('listTaskAssignmentsForUser', { userId: 'u1' }))).rejects.toThrow(
      'no active support link',
    );
  });

  it('allows the operations for a selected user (delegation resolves) — getTaskInstanceViews checks the user', async () => {
    mockQueryAllItems.mockResolvedValue([]);
    await handler(event('getTaskInstanceViews', { userId: 'u1', startDate: '2099-07-01', endDate: '2099-07-03' }));
    expect(mockAssertCanAct).toHaveBeenCalledWith(expect.objectContaining({ sub: 'assigner-1' }), 'u1');
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
    // Active timing starts at zero, with no step active yet.
    expect(instance.activeDurationSeconds).toBe(0);
    expect(instance.activeStepId).toBeUndefined();
    // Instance Put is guarded so steps snapshot exactly once.
    const instancePut = tx[0].TransactItems.find((t: Rec) => t.Put.Item.entityType === 'TaskInstance');
    expect(instancePut.Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    // One step snapshot per TaskStep, text only (NOT media), completed=false, timing at zero.
    const steps = items.filter((i: Rec) => i.entityType === 'TaskInstanceStep');
    expect(steps).toHaveLength(2);
    expect(steps[0].SK).toBe('TASK_INSTANCE_STEP#a1#2099-07-02#09:00#STEP#s1');
    expect(steps[0].mediaAssets).toBeUndefined();
    expect(steps.every((s: Rec) => s.completed === false)).toBe(true);
    expect(steps.every((s: Rec) => s.activeDurationSeconds === 0)).toBe(true);
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.activeDurationSeconds).toBe(0);
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

  it('closes the active step before completing it, accumulating its active seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId: 'a1#2099-07-02#09:00',
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
      activeStepId: 's1',
      activeStepStartedAt: '2099-07-02T09:00:00.000Z', // 600s before "now"
      activeDurationSeconds: 0,
    };
    db.steps = { s1: { stepId: 's1', completed: false, activeDurationSeconds: 0 } };

    const result = (await handler(
      event('setTaskInstanceStepCompletion', { input: args }),
    )) as TaskInstanceStep;

    // A transaction (step + instance), not a lone UpdateCommand, since it closes the timer.
    const tx = byCommand('TransactWriteCommand');
    expect(tx).toHaveLength(1);
    expect(byCommand('UpdateCommand')).toHaveLength(0);
    const stepUpdate = tx[0].TransactItems.find((t: Rec) => t.Update.Key.SK.includes('STEP#s1')).Update;
    expect(stepUpdate.UpdateExpression).toContain('completed = :true');
    expect(stepUpdate.ExpressionAttributeValues[':delta']).toBe(600);
    const instUpdate = tx[0].TransactItems.find((t: Rec) => t.Update.Key.SK === 'TASK_INSTANCE#2099-07-02#09:00#a1')!.Update;
    expect(instUpdate.UpdateExpression).toContain('REMOVE activeStepId, activeStepStartedAt');
    expect(instUpdate.ExpressionAttributeValues[':delta']).toBe(600);
    // The instance write is guarded on the exact pointer observed (prevents double-counting).
    expect(instUpdate.ConditionExpression).toContain('activeStepStartedAt = :expActiveStepStartedAt');
    // Returned step reflects the closed timer.
    expect(result.completed).toBe(true);
    expect(result.completedAt).toBe('2099-07-02T09:10:00.000Z');
    expect(result.activeDurationSeconds).toBe(600);
  });

  it('falls back to plain completion (no extra duration) when it loses the close race', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    // First read: s1 is the active step. A concurrent pause closes it before our transaction lands,
    // so the retry read shows it no longer active — we then just mark it completed, adding nothing.
    const active = {
      status: 'IN_PROGRESS', instanceId: 'a1#2099-07-02#09:00',
      scheduledDate: '2099-07-02', scheduledTime: '09:00',
      activeStepId: 's1', activeStepStartedAt: '2099-07-02T09:00:00.000Z', activeDurationSeconds: 0,
    };
    const closed = { ...active, activeDurationSeconds: 600 };
    delete (closed as Rec).activeStepId;
    delete (closed as Rec).activeStepStartedAt;
    let instanceGets = 0;
    let transacts = 0;
    let updates = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'GetCommand') {
        const sk: string = command.input.Key.SK;
        if (sk.startsWith('TASK_INSTANCE_STEP#')) return Promise.resolve({ Item: { stepId: 's1', completed: false, activeDurationSeconds: 600 } });
        if (sk.startsWith('TASK_INSTANCE#')) return Promise.resolve({ Item: instanceGets++ === 0 ? active : closed });
      }
      if (name === 'TransactWriteCommand') {
        transacts++;
        return Promise.reject(Object.assign(new Error('conflict'), { name: 'TransactionCanceledException' }));
      }
      if (name === 'UpdateCommand') {
        updates++;
        return Promise.resolve({ Attributes: { stepId: 's1', completed: true, completedAt: '2099-07-02T09:10:00.000Z', activeDurationSeconds: 600 } });
      }
      return Promise.resolve({});
    });

    const result = (await handler(
      event('setTaskInstanceStepCompletion', { input: args }),
    )) as TaskInstanceStep;

    expect(transacts).toBe(1); // the losing active-close attempt
    expect(updates).toBe(1); // fallback plain completion (no duration added)
    expect(result.completed).toBe(true);
    expect(result.activeDurationSeconds).toBe(600); // the winner's accumulation, not doubled
  });

  it('adds no duration when completing a non-active step', async () => {
    db.instance = { status: 'IN_PROGRESS', activeStepId: 's2', activeStepStartedAt: 'x' };
    mockSend.mockImplementationOnce(() => Promise.resolve({ Item: db.instance })); // getInstance
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({ Attributes: { stepId: 's1', completed: true, completedAt: 'now' } }),
    );
    const result = (await handler(
      event('setTaskInstanceStepCompletion', { input: args }),
    )) as TaskInstanceStep;
    // Plain UpdateCommand path — no transaction, no duration accumulation.
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    expect(byCommand('UpdateCommand')).toHaveLength(1);
    expect(result.completed).toBe(true);
  });

  it('404s when the instance does not exist', async () => {
    db.instance = undefined;
    await expect(handler(event('setTaskInstanceStepCompletion', { input: args }))).rejects.toThrow(
      'task instance a1#2099-07-02#09:00 not found',
    );
  });
});

// ── startTaskInstanceStep / pauseTaskInstanceTimer (active-step timing) ────────
describe('startTaskInstanceStep', () => {
  const instanceId = 'a1#2099-07-02#09:00';
  const runningInstance = (over: Rec = {}): Rec => ({
    status: 'IN_PROGRESS',
    instanceId,
    scheduledDate: '2099-07-02',
    scheduledTime: '09:00',
    activeDurationSeconds: 0,
    ...over,
  });
  const txItems = (): Rec[] => byCommand('TransactWriteCommand')[0].TransactItems;
  const txUpdate = (skPart: string): Rec =>
    txItems().find((t) => t.Update?.Key.SK.includes(skPart))!.Update;

  it('starts a step when none is active (no previous step to close)', async () => {
    db.instance = runningInstance();
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 0 } };

    const result = (await handler(
      event('startTaskInstanceStep', { input: { userId: 'u1', instanceId, stepId: 's1' } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    expect(byCommand('TransactWriteCommand')).toHaveLength(1);
    expect(txItems()).toHaveLength(2); // instance + new step, no previous to close
    const inst = txUpdate('TASK_INSTANCE#2099-07-02#09:00#a1');
    expect(inst.ExpressionAttributeValues[':stepId']).toBe('s1');
    expect(inst.ExpressionAttributeValues[':delta']).toBe(0);
    const step = txUpdate('STEP#s1');
    expect(step.UpdateExpression).toContain('firstStartedAt = if_not_exists(firstStartedAt, :now)');
    expect(step.UpdateExpression).toContain('lastStartedAt = :now');
    expect(result.instance.activeStepId).toBe('s1');
    expect(result.activeStep?.stepId).toBe('s1');
    expect(result.activeStep?.firstStartedAt).toBeDefined();
    expect(result.previousStep).toBeNull();
  });

  it('switches from step1 to step2 and accumulates step1 active seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = runningInstance({
      activeStepId: 's1',
      activeStepStartedAt: '2099-07-02T09:00:00.000Z', // 600s ago
      activeDurationSeconds: 0,
    });
    db.steps = {
      s1: { stepId: 's1', activeDurationSeconds: 0, firstStartedAt: '2099-07-02T09:00:00.000Z' },
      s2: { stepId: 's2', activeDurationSeconds: 0 },
    };

    const result = (await handler(
      event('startTaskInstanceStep', { input: { userId: 'u1', instanceId, stepId: 's2' } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    expect(txItems()).toHaveLength(3); // instance + new step (s2) + closed step (s1)
    const inst = txUpdate('TASK_INSTANCE#2099-07-02#09:00#a1');
    expect(inst.ExpressionAttributeValues[':stepId']).toBe('s2');
    expect(inst.ExpressionAttributeValues[':delta']).toBe(600);
    const closed = txUpdate('STEP#s1');
    expect(closed.ExpressionAttributeValues[':delta']).toBe(600);
    // Instance total and previous step both accumulate the 600s the timer ran on step1.
    expect(result.instance.activeStepId).toBe('s2');
    expect(result.instance.activeDurationSeconds).toBe(600);
    expect(result.previousStep?.stepId).toBe('s1');
    expect(result.previousStep?.activeDurationSeconds).toBe(600);
    expect(result.activeStep?.stepId).toBe('s2');
  });

  it('is idempotent when the same step is already active (no write)', async () => {
    db.instance = runningInstance({
      activeStepId: 's1',
      activeStepStartedAt: '2099-07-02T09:00:00.000Z',
      activeDurationSeconds: 42,
    });
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 30 } };

    const result = (await handler(
      event('startTaskInstanceStep', { input: { userId: 'u1', instanceId, stepId: 's1' } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    expect(byCommand('UpdateCommand')).toHaveLength(0);
    expect(result.instance.activeStepId).toBe('s1');
    expect(result.instance.activeDurationSeconds).toBe(42); // unchanged
    expect(result.activeStep?.stepId).toBe('s1');
    expect(result.previousStep).toBeNull();
  });

  it('rejects starting a step on a terminal (COMPLETED) instance', async () => {
    db.instance = runningInstance({ status: 'COMPLETED' });
    await expect(
      handler(event('startTaskInstanceStep', { input: { userId: 'u1', instanceId, stepId: 's1' } })),
    ).rejects.toThrow('cannot change timing on a COMPLETED instance');
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
  });

  it('404s when the requested step snapshot does not exist', async () => {
    db.instance = runningInstance();
    db.steps = {}; // no s1 snapshot
    await expect(
      handler(event('startTaskInstanceStep', { input: { userId: 'u1', instanceId, stepId: 's1' } })),
    ).rejects.toThrow('step s1 not found');
  });

  it('re-points a stale previous pointer without counting its delta on the instance', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = runningInstance({
      activeStepId: 'gone', // previous active step whose snapshot no longer exists
      activeStepStartedAt: '2099-07-02T09:00:00.000Z',
      activeDurationSeconds: 15,
    });
    db.steps = { s2: { stepId: 's2', activeDurationSeconds: 0 } }; // only the new step exists

    const result = (await handler(
      event('startTaskInstanceStep', { input: { userId: 'u1', instanceId, stepId: 's2' } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    // Only instance + new step are written (no close of the missing 'gone' snapshot), delta 0 —
    // the instance total stays consistent with the sum of real steps rather than diverging.
    expect(txItems()).toHaveLength(2);
    const inst = txUpdate('TASK_INSTANCE#2099-07-02#09:00#a1');
    expect(inst.ExpressionAttributeValues[':delta']).toBe(0);
    expect(result.instance.activeStepId).toBe('s2');
    expect(result.instance.activeDurationSeconds).toBe(15); // unchanged — nothing accumulated
    expect(result.previousStep).toBeNull();
  });
});

describe('pauseTaskInstanceTimer', () => {
  const instanceId = 'a1#2099-07-02#09:00';
  const txItems = (): Rec[] => byCommand('TransactWriteCommand')[0].TransactItems;

  it('closes the active step, accumulates its seconds, and clears activeStepId', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId,
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
      activeStepId: 's1',
      activeStepStartedAt: '2099-07-02T09:00:00.000Z', // 600s ago
      activeDurationSeconds: 5,
    };
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 10 } };

    const result = (await handler(
      event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    expect(byCommand('TransactWriteCommand')).toHaveLength(1);
    const inst = txItems().find((t) => t.Update.Key.SK === 'TASK_INSTANCE#2099-07-02#09:00#a1')!.Update;
    expect(inst.UpdateExpression).toContain('REMOVE activeStepId, activeStepStartedAt');
    expect(inst.ExpressionAttributeValues[':delta']).toBe(600);
    // Instance total = 5 + 600; the step it closed = 10 + 600. No active step remains.
    expect(result.instance.activeDurationSeconds).toBe(605);
    expect(result.instance.activeStepId).toBeUndefined();
    expect(result.activeStep).toBeNull();
    expect(result.previousStep?.stepId).toBe('s1');
    expect(result.previousStep?.activeDurationSeconds).toBe(610);
  });

  it('is idempotent when nothing is active (no write)', async () => {
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId,
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
      activeDurationSeconds: 7,
    };
    const result = (await handler(
      event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    expect(result.instance.activeDurationSeconds).toBe(7);
    expect(result.activeStep).toBeNull();
    expect(result.previousStep).toBeNull();
  });

  it('clears a stale active pointer without counting when its step snapshot is missing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId,
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
      activeStepId: 'gone',
      activeStepStartedAt: '2099-07-02T09:00:00.000Z',
      activeDurationSeconds: 12,
    };
    db.steps = {}; // the pointed-to snapshot no longer exists

    const result = (await handler(
      event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    // The instance pointer is cleared, but nothing is added anywhere (no step to attribute it to).
    const tx = byCommand('TransactWriteCommand')[0];
    expect(tx.TransactItems).toHaveLength(1); // instance only; no step write
    expect(tx.TransactItems[0].Update.ExpressionAttributeValues[':delta']).toBe(0);
    expect(result.instance.activeDurationSeconds).toBe(12); // unchanged
    expect(result.instance.activeStepId).toBeUndefined();
    expect(result.previousStep).toBeNull();
  });

  it('guards the instance write on the exact active pointer it observed (optimistic concurrency)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS', instanceId, scheduledDate: '2099-07-02', scheduledTime: '09:00',
      activeStepId: 's1', activeStepStartedAt: '2099-07-02T09:00:00.000Z', activeDurationSeconds: 0,
    };
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 0 } };

    await handler(event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } }));

    const inst = txItems().find((t) => t.Update.Key.SK === 'TASK_INSTANCE#2099-07-02#09:00#a1')!.Update;
    expect(inst.ConditionExpression).toContain('activeStepId = :expActiveStepId');
    expect(inst.ConditionExpression).toContain('activeStepStartedAt = :expActiveStepStartedAt');
    expect(inst.ExpressionAttributeValues[':expActiveStepId']).toBe('s1');
    expect(inst.ExpressionAttributeValues[':expActiveStepStartedAt']).toBe('2099-07-02T09:00:00.000Z');
  });

  it('retries and converges to an idempotent no-op when it loses the close race', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    // First read: a step is active. A concurrent writer closes it, so the retry read has none.
    const active = {
      status: 'IN_PROGRESS', instanceId, scheduledDate: '2099-07-02', scheduledTime: '09:00',
      activeStepId: 's1', activeStepStartedAt: '2099-07-02T09:00:00.000Z', activeDurationSeconds: 5,
    };
    const closed = { ...active, activeDurationSeconds: 605 };
    delete (closed as Rec).activeStepId;
    delete (closed as Rec).activeStepStartedAt;
    let instanceGets = 0;
    let transacts = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'GetCommand') {
        const sk: string = command.input.Key.SK;
        if (sk.startsWith('TASK_INSTANCE_STEP#')) return Promise.resolve({ Item: { stepId: 's1', activeDurationSeconds: 5 } });
        if (sk.startsWith('TASK_INSTANCE#')) return Promise.resolve({ Item: instanceGets++ === 0 ? active : closed });
      }
      if (name === 'TransactWriteCommand') {
        transacts++;
        return Promise.reject(Object.assign(new Error('conflict'), { name: 'TransactionCanceledException' }));
      }
      return Promise.resolve({});
    });

    const result = (await handler(
      event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    expect(transacts).toBe(1); // the losing attempt; the retry re-read found nothing to close
    expect(result.instance.activeStepId).toBeUndefined();
    expect(result.instance.activeDurationSeconds).toBe(605); // reflects the winner's write
    expect(result.previousStep).toBeNull();
  });

  it('clears a corrupt active pointer that has no activeStepStartedAt (self-healing)', async () => {
    db.instance = {
      status: 'IN_PROGRESS', instanceId, scheduledDate: '2099-07-02', scheduledTime: '09:00',
      activeStepId: 's1', // present, but activeStepStartedAt missing (corrupt/legacy partial pointer)
      activeDurationSeconds: 3,
    };

    const result = (await handler(
      event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } }),
    )) as import('../../shared/types').TaskInstanceTimingResult;

    const tx = byCommand('TransactWriteCommand')[0];
    expect(tx.TransactItems).toHaveLength(1); // no step write — nothing to attribute
    const inst = tx.TransactItems[0].Update;
    expect(inst.ExpressionAttributeValues[':delta']).toBe(0);
    // Guard matches the corrupt shape: pointer present, no start.
    expect(inst.ConditionExpression).toContain('attribute_not_exists(activeStepStartedAt)');
    expect(result.instance.activeStepId).toBeUndefined(); // cleared, not left dangling
    expect(result.instance.activeDurationSeconds).toBe(3); // nothing counted
    expect(result.previousStep).toBeNull();
  });

  it('rejects pausing a terminal (CANCELLED) instance', async () => {
    db.instance = { status: 'CANCELLED', instanceId, scheduledDate: '2099-07-02', scheduledTime: '09:00' };
    await expect(
      handler(event('pauseTaskInstanceTimer', { input: { userId: 'u1', instanceId } })),
    ).rejects.toThrow('cannot change timing on a CANCELLED instance');
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
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

  it('records elapsedSeconds (startedAt→now) when completing with no active step', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId: 'a1#2099-07-02#09:00',
      startedAt: '2099-07-02T09:00:00.000Z', // 600s before "now"
      activeDurationSeconds: 250,
    };
    mockQueryAllItems.mockResolvedValue([{ completed: true }]);
    const result = (await handler(
      event('updateTaskInstanceStatus', { input: { ...base, status: 'COMPLETED' } }),
    )) as TaskInstance;
    // Single in-place update (no timer running), stamping elapsedSeconds and clearing any pointer.
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('elapsedSeconds = :elapsed');
    expect(update.UpdateExpression).toContain('REMOVE skippedAt, activeStepId, activeStepStartedAt');
    expect(update.ExpressionAttributeValues[':elapsed']).toBe(600);
    expect(result.status).toBe('COMPLETED');
  });

  it('closes a running step and sets elapsedSeconds when completing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId: 'a1#2099-07-02#09:00',
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
      startedAt: '2099-07-02T09:00:00.000Z', // elapsed = 600s
      activeStepId: 's1',
      activeStepStartedAt: '2099-07-02T09:05:00.000Z', // step delta = 300s
      activeDurationSeconds: 100,
    };
    mockQueryAllItems.mockResolvedValue([{ completed: true }]);
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 100 } };

    const result = (await handler(
      event('updateTaskInstanceStatus', { input: { ...base, status: 'COMPLETED' } }),
    )) as TaskInstance;

    const tx = byCommand('TransactWriteCommand');
    expect(tx).toHaveLength(1);
    const inst = tx[0].TransactItems.find((t: Rec) => t.Update.Key.SK === 'TASK_INSTANCE#2099-07-02#09:00#a1')!.Update;
    expect(inst.ExpressionAttributeValues[':elapsed']).toBe(600);
    expect(inst.ExpressionAttributeValues[':delta']).toBe(300);
    expect(inst.UpdateExpression).toContain('REMOVE skippedAt, activeStepId, activeStepStartedAt');
    // elapsedSeconds is wall-clock (600); activeDurationSeconds accumulates the 300s step run.
    expect(result.status).toBe('COMPLETED');
    expect(result.elapsedSeconds).toBe(600);
    expect(result.activeDurationSeconds).toBe(400);
    expect(result.activeStepId).toBeUndefined();
  });

  it('clears completedAt/skippedAt when moving to IN_PROGRESS', async () => {
    db.instance = { status: 'IN_PROGRESS' };
    await handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'IN_PROGRESS' } }));
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('startedAt = if_not_exists(startedAt, :now)');
    expect(update.UpdateExpression).toContain('REMOVE completedAt, skippedAt');
  });

  it('allows undoing SKIPPED back to IN_PROGRESS, clearing skippedAt', async () => {
    db.instance = { status: 'SKIPPED', skippedAt: 'old-skip-time' };
    const result = (await handler(
      event('updateTaskInstanceStatus', { input: { ...base, status: 'IN_PROGRESS' } }),
    )) as TaskInstance;
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('#status = :status');
    expect(update.UpdateExpression).toContain('startedAt = if_not_exists(startedAt, :now)');
    expect(update.UpdateExpression).toContain('REMOVE completedAt, skippedAt');
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('rejects COMPLETED while a step is incomplete', async () => {
    db.instance = { status: 'IN_PROGRESS' };
    mockQueryAllItems.mockResolvedValue([{ completed: true }, { completed: false }]);
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'COMPLETED' } })),
    ).rejects.toThrow('one or more steps are incomplete');
    expect(byCommand('UpdateCommand')).toHaveLength(0);
  });

  it('SKIPPED with no active step is a single update that clears any stale active pointer', async () => {
    db.instance = { status: 'IN_PROGRESS', instanceId: 'a1#2099-07-02#09:00' };
    const result = (await handler(
      event('updateTaskInstanceStatus', { input: { ...base, status: 'SKIPPED' } }),
    )) as TaskInstance;
    expect(byCommand('TransactWriteCommand')).toHaveLength(0);
    const update = byCommand('UpdateCommand')[0];
    expect(update.UpdateExpression).toContain('skippedAt = :now');
    expect(update.UpdateExpression).toContain('REMOVE completedAt, activeStepId, activeStepStartedAt');
    expect(result.status).toBe('SKIPPED');
  });

  it('SKIPPED closes a running step and clears activeStepId (no stale timer on a terminal instance)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.instance = {
      status: 'IN_PROGRESS',
      instanceId: 'a1#2099-07-02#09:00',
      scheduledDate: '2099-07-02',
      scheduledTime: '09:00',
      activeStepId: 's1',
      activeStepStartedAt: '2099-07-02T09:00:00.000Z', // 600s ago
      activeDurationSeconds: 40,
    };
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 40 } };

    const result = (await handler(
      event('updateTaskInstanceStatus', { input: { ...base, status: 'SKIPPED' } }),
    )) as TaskInstance;

    const tx = byCommand('TransactWriteCommand');
    expect(tx).toHaveLength(1);
    const inst = tx[0].TransactItems.find((t: Rec) => t.Update.Key.SK === 'TASK_INSTANCE#2099-07-02#09:00#a1')!.Update;
    expect(inst.ExpressionAttributeValues[':delta']).toBe(600);
    expect(inst.UpdateExpression).toContain('skippedAt = :now');
    expect(inst.UpdateExpression).toContain('REMOVE completedAt, activeStepId, activeStepStartedAt');
    // Final active time accumulated; no active pointer survives onto the terminal instance.
    expect(result.status).toBe('SKIPPED');
    expect(result.activeDurationSeconds).toBe(640);
    expect(result.activeStepId).toBeUndefined();
    expect(result.activeStepStartedAt).toBeUndefined();
  });

  it('rejects changing the status of a terminal (COMPLETED) instance — no rewinding', async () => {
    db.instance = { status: 'COMPLETED' };
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'IN_PROGRESS' } })),
    ).rejects.toThrow('cannot change status of a COMPLETED instance');
    expect(byCommand('UpdateCommand')).toHaveLength(0);
  });

  it('rejects changing SKIPPED to anything except IN_PROGRESS', async () => {
    db.instance = { status: 'SKIPPED' };
    await expect(
      handler(event('updateTaskInstanceStatus', { input: { ...base, status: 'COMPLETED' } })),
    ).rejects.toThrow('cannot change status of a SKIPPED instance');
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

  it('closes a running step and clears activeStepId when cancelling an active instance', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2099-07-02T09:10:00.000Z'));
    db.assignment = RECURRING;
    db.instance = {
      instanceId: 'a1#2099-07-02#09:00', status: 'IN_PROGRESS',
      scheduledDate: '2099-07-02', scheduledTime: '09:00', startedAt: 'earlier',
      activeStepId: 's1', activeStepStartedAt: '2099-07-02T09:00:00.000Z', // 600s ago
      activeDurationSeconds: 20,
    };
    db.steps = { s1: { stepId: 's1', activeDurationSeconds: 20 } };

    const result = (await handler(event('cancelTaskInstance', { input: cancelArgs }))) as TaskInstance;

    // Cancelling an active instance closes the step transactionally rather than via a lone upsert.
    const tx = byCommand('TransactWriteCommand');
    expect(tx).toHaveLength(1);
    const inst = tx[0].TransactItems.find((t: Rec) => t.Update.Key.SK === 'TASK_INSTANCE#2099-07-02#09:00#a1')!.Update;
    expect(inst.ExpressionAttributeValues[':delta']).toBe(600);
    expect(inst.UpdateExpression).toContain('REMOVE completedAt, skippedAt, activeStepId, activeStepStartedAt');
    expect(result.status).toBe('CANCELLED');
    expect(result.isException).toBe(true);
    expect(result.activeDurationSeconds).toBe(620); // 20 + 600
    expect(result.activeStepId).toBeUndefined();
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

// ── getTaskInstance / listTaskInstances / batchGetTaskInstances (self-scoped reads) ──
/** A stored TaskInstance row (with PK/SK/entityType), overridable per test. */
const storedInstance = (over: Rec = {}): Rec => ({
  instanceId: 'a1#2099-07-02#09:00',
  assignmentId: 'a1',
  taskId: 't1',
  userId: 'u1',
  scheduledDate: '2099-07-02',
  scheduledTime: '09:00',
  scheduledFor: '2099-07-02T09:00:00.000Z',
  timezone: 'UTC',
  status: 'IN_PROGRESS',
  PK: 'USER#u1',
  SK: 'TASK_INSTANCE#2099-07-02#09:00#a1',
  entityType: 'TaskInstance',
  createdAt: 'x',
  ...over,
});

/** An event with NO authenticated identity (for the unauthenticated-caller checks). */
function anonEvent(fieldName: string, args: Record<string, unknown>) {
  return { arguments: args, info: { fieldName } } as Parameters<typeof handler>[0];
}

describe('getTaskInstance', () => {
  it("returns the caller's own instance, keyed under USER#<sub>, with storage stripped", async () => {
    db.instance = storedInstance();
    const result = (await handler(
      event('getTaskInstance', { instanceId: 'a1#2099-07-02#09:00' }, 'u1'),
    )) as TaskInstance;

    expect(inputs()[0].Key).toEqual({ PK: 'USER#u1', SK: 'TASK_INSTANCE#2099-07-02#09:00#a1' });
    expect(result.instanceId).toBe('a1#2099-07-02#09:00');
    expect(result.status).toBe('IN_PROGRESS');
    expect((result as Rec).PK).toBeUndefined();
    expect((result as Rec).SK).toBeUndefined();
    expect((result as Rec).entityType).toBeUndefined();
  });

  it('returns null when the instance does not exist', async () => {
    db.instance = undefined;
    const result = await handler(event('getTaskInstance', { instanceId: 'a1#2099-07-02#09:00' }, 'u1'));
    expect(result).toBeNull();
  });

  it('rejects an invalid instanceId without reading DynamoDB', async () => {
    await expect(handler(event('getTaskInstance', { instanceId: 'not-a-valid-id' }, 'u1'))).rejects.toThrow(
      'invalid instanceId',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(
      handler(anonEvent('getTaskInstance', { instanceId: 'a1#2099-07-02#09:00' })),
    ).rejects.toThrow('authenticated user is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses the caller sub, never a client-provided userId', async () => {
    db.instance = storedInstance();
    await handler(
      event('getTaskInstance', { instanceId: 'a1#2099-07-02#09:00', userId: 'attacker' }, 'u1'),
    );
    // The row is read from the CALLER's partition, not the injected userId.
    expect(inputs()[0].Key.PK).toBe('USER#u1');
  });
});

describe('listTaskInstances', () => {
  it('queries only USER#<sub> with a TASK_INSTANCE# date-range BETWEEN', async () => {
    db.instancesInRange = [storedInstance()];
    const result = (await handler(
      event('listTaskInstances', { startDate: '2099-07-01', endDate: '2099-07-03' }, 'u1'),
    )) as Connection<TaskInstance>;

    const q = inputs()[0];
    expect(q.KeyConditionExpression).toBe('PK = :pk AND SK BETWEEN :lo AND :hi');
    expect(q.ExpressionAttributeValues[':pk']).toBe('USER#u1');
    expect(q.ExpressionAttributeValues[':lo']).toBe('TASK_INSTANCE#2099-07-01');
    expect(q.ExpressionAttributeValues[':hi']).toBe('TASK_INSTANCE#2099-07-03#￿');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].instanceId).toBe('a1#2099-07-02#09:00');
    expect((result.items[0] as Rec).PK).toBeUndefined();
  });

  it('supports limit and round-trips an opaque nextToken', async () => {
    const startKey = { PK: 'USER#u1', SK: 'TASK_INSTANCE#2099-07-02#09:00#a1' };
    const inToken = Buffer.from(JSON.stringify(startKey), 'utf8').toString('base64');
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [storedInstance()],
          LastEvaluatedKey: { PK: 'USER#u1', SK: 'TASK_INSTANCE#2099-07-03#09:00#a1' },
        });
      }
      return Promise.resolve({});
    });

    const result = (await handler(
      event('listTaskInstances', { startDate: '2099-07-01', endDate: '2099-07-10', limit: 5, nextToken: inToken }, 'u1'),
    )) as Connection<TaskInstance>;

    const q = inputs()[0];
    expect(q.Limit).toBe(5);
    expect(q.ExclusiveStartKey).toEqual(startKey);
    expect(result.nextToken).toBe(
      Buffer.from(JSON.stringify({ PK: 'USER#u1', SK: 'TASK_INSTANCE#2099-07-03#09:00#a1' }), 'utf8').toString('base64'),
    );
  });

  it('rejects date ranges beyond the existing max span', async () => {
    await expect(
      handler(event('listTaskInstances', { startDate: '2026-01-01', endDate: '2030-01-01' }, 'u1')),
    ).rejects.toThrow('at most 370 days');
  });

  it('never synthesizes virtual occurrences (returns only real rows)', async () => {
    // An active recurring assignment exists, but listTaskInstances must ignore it entirely.
    mockQueryAllItems.mockResolvedValue([RECURRING]);
    db.instancesInRange = [];
    const result = (await handler(
      event('listTaskInstances', { startDate: '2099-07-01', endDate: '2099-07-03' }, 'u1'),
    )) as Connection<TaskInstance>;
    expect(result.items).toHaveLength(0);
    expect(mockQueryAllItems).not.toHaveBeenCalled(); // no assignment expansion happens
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(
      handler(anonEvent('listTaskInstances', { startDate: '2099-07-01', endDate: '2099-07-03' })),
    ).rejects.toThrow('authenticated user is required');
  });
});

describe('batchGetTaskInstances', () => {
  /** Mock BatchGetCommand against an in-memory store keyed by SK. */
  function withStore(store: Record<string, Rec>) {
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      if (command.constructor.name === 'BatchGetCommand') {
        const keys: Rec[] = command.input.RequestItems['CanPlan-test'].Keys;
        const items = keys.map((k) => store[k.SK]).filter(Boolean);
        return Promise.resolve({ Responses: { 'CanPlan-test': items } });
      }
      return Promise.resolve({});
    });
  }
  const A = 'a1#2099-07-02#09:00';
  const skA = 'TASK_INSTANCE#2099-07-02#09:00#a1';
  const B = 'a2#2099-07-05#10:00';
  const skB = 'TASK_INSTANCE#2099-07-05#10:00#a2';

  it('returns results in the SAME order as the requested ids', async () => {
    withStore({
      [skA]: storedInstance(),
      [skB]: storedInstance({ instanceId: B, assignmentId: 'a2', scheduledDate: '2099-07-05', scheduledTime: '10:00', PK: 'USER#u1', SK: skB, scheduledFor: '2099-07-05T10:00:00.000Z' }),
    });
    const result = (await handler(
      event('batchGetTaskInstances', { instanceIds: [B, A] }, 'u1'),
    )) as { instanceId: string; item: TaskInstance | null }[];

    expect(result.map((r) => r.instanceId)).toEqual([B, A]);
    expect(result[0].item?.instanceId).toBe(B);
    expect(result[1].item?.instanceId).toBe(A);
    expect((result[0].item as Rec).PK).toBeUndefined();
  });

  it('returns { item: null } for ids that do not exist for the caller', async () => {
    withStore({ [skA]: storedInstance() });
    const missing = 'a9#2099-07-09#11:00';
    const result = (await handler(
      event('batchGetTaskInstances', { instanceIds: [A, missing] }, 'u1'),
    )) as { instanceId: string; item: TaskInstance | null }[];
    expect(result[0].item?.instanceId).toBe(A);
    expect(result[1]).toEqual({ instanceId: missing, item: null });
  });

  it('reads only from USER#<sub> (caller partition)', async () => {
    withStore({ [skA]: storedInstance() });
    await handler(event('batchGetTaskInstances', { instanceIds: [A, B] }, 'u1'));
    const keys: Rec[] = byCommand('BatchGetCommand')[0].RequestItems['CanPlan-test'].Keys;
    expect(keys.every((k) => k.PK === 'USER#u1')).toBe(true);
  });

  it('rejects an empty instanceIds list without any read', async () => {
    await expect(handler(event('batchGetTaskInstances', { instanceIds: [] }, 'u1'))).rejects.toThrow(
      'cannot be empty',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `a1#2099-07-02#${String(i).padStart(2, '0')}:00`);
    await expect(handler(event('batchGetTaskInstances', { instanceIds: ids }, 'u1'))).rejects.toThrow(
      'at most 100',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an invalid instanceId without reading DynamoDB', async () => {
    await expect(
      handler(event('batchGetTaskInstances', { instanceIds: [A, 'garbage'] }, 'u1')),
    ).rejects.toThrow('invalid instanceId');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(handler(anonEvent('batchGetTaskInstances', { instanceIds: [A] }))).rejects.toThrow(
      'authenticated user is required',
    );
  });
});

describe('read APIs derive OVERDUE consistently with getTaskInstanceViews', () => {
  it('surfaces a past-due non-terminal instance as OVERDUE (without rewriting the row)', async () => {
    db.instance = storedInstance({
      instanceId: 'a1#2000-01-01#09:00',
      scheduledDate: '2000-01-01',
      scheduledFor: '2000-01-01T09:00:00.000Z',
      status: 'IN_PROGRESS',
      SK: 'TASK_INSTANCE#2000-01-01#09:00#a1',
    });
    const result = (await handler(
      event('getTaskInstance', { instanceId: 'a1#2000-01-01#09:00' }, 'u1'),
    )) as TaskInstance;
    expect(result.status).toBe('OVERDUE');
    // Read-only: no write command was issued.
    expect(byCommand('UpdateCommand')).toHaveLength(0);
    expect(byCommand('PutCommand')).toHaveLength(0);
  });

  it('leaves terminal statuses (COMPLETED/SKIPPED/CANCELLED) unchanged even when past-due', async () => {
    for (const status of ['COMPLETED', 'SKIPPED', 'CANCELLED'] as const) {
      jest.clearAllMocks();
      db.instance = storedInstance({
        instanceId: 'a1#2000-01-01#09:00',
        scheduledDate: '2000-01-01',
        scheduledFor: '2000-01-01T09:00:00.000Z',
        status,
        SK: 'TASK_INSTANCE#2000-01-01#09:00#a1',
      });
      const result = (await handler(
        event('getTaskInstance', { instanceId: 'a1#2000-01-01#09:00' }, 'u1'),
      )) as TaskInstance;
      expect(result.status).toBe(status);
    }
  });
});

// ── backward compatibility (legacy rows without activeDurationSeconds) ─────────
describe('legacy rows missing activeDurationSeconds default to 0', () => {
  it('getTaskInstance returns activeDurationSeconds: 0 for a legacy instance row', async () => {
    // storedInstance() carries no activeDurationSeconds (pre-timing row).
    db.instance = storedInstance();
    const result = (await handler(
      event('getTaskInstance', { instanceId: 'a1#2099-07-02#09:00' }, 'u1'),
    )) as TaskInstance;
    expect(result.activeDurationSeconds).toBe(0);
  });

  it('listTaskInstanceSteps returns activeDurationSeconds: 0 for legacy step snapshots', async () => {
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({ Items: [{ stepId: 's1', order: 1, text: 'x', completed: false }] });
      }
      return Promise.resolve({});
    });
    const result = (await handler(
      event('listTaskInstanceSteps', { userId: 'u1', instanceId: 'a1#2099-07-02#09:00' }),
    )) as Connection<TaskInstanceStep>;
    expect(result.items[0].activeDurationSeconds).toBe(0);
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
