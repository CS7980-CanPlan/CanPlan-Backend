// Issue #43 — deleteTask must allow deletion only when the Task's activeAssignmentCount is 0
// (or the field is absent on a legacy row). The decision is driven by the strongly-consistent
// counter on the #META item, never an eventually-consistent GSI query.
import { handler } from './handler';
import { readTaskMeta, deleteTaskCascade } from '../../shared/taskCascade';
import { assertCanActForUser } from '../../shared/delegation';
import type { Task } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));

// Manage-access authorization is unit-tested in shared/delegation.test.ts; mocked here to
// resolve by default so the tests exercise only the deletion guard.
jest.mock('../../shared/delegation', () => {
  const actual = jest.requireActual('../../shared/delegation');
  return { ...actual, assertCanActForUser: jest.fn() };
});

// The #META read + the cascade are exercised elsewhere with the real implementations; mocked
// here so each test asserts ONLY the deletion decision and whether the cascade is delegated to.
jest.mock('../../shared/taskCascade', () => ({ readTaskMeta: jest.fn(), deleteTaskCascade: jest.fn() }));

// The legacy GSI-based guard is neutralized (no-op), so the ONLY thing that can block deletion
// is the Task's own activeAssignmentCount field.
jest.mock('../../shared/assignment', () => ({
  assertNoActiveAssignmentsForTask: jest.fn().mockResolvedValue(undefined),
  countActiveAssignmentsForTask: jest.fn().mockResolvedValue(0),
  queryActiveAssignmentKeysForTask: jest.fn().mockResolvedValue([]),
}));

const mockReadTaskMeta = readTaskMeta as jest.Mock;
const mockCascade = deleteTaskCascade as jest.Mock;
const mockAssertCanAct = assertCanActForUser as jest.Mock;

const OWNER = 'o1';

/** A Task #META owned by OWNER; override activeAssignmentCount per test. */
const meta = (extra: Record<string, unknown> = {}): Task =>
  ({ taskId: 't1', ownerId: OWNER, title: 'T', categoryId: 'cat-1', createdAt: 'c', ...extra } as Task);

beforeEach(() => {
  mockAssertCanAct.mockResolvedValue(OWNER);
  mockCascade.mockImplementation(async (id: string) => meta({ taskId: id }));
});
afterEach(() => jest.clearAllMocks());

function event(taskId: string, sub: string | null = OWNER) {
  return {
    arguments: { taskId },
    info: { fieldName: 'deleteTask' },
    identity: sub ? { sub } : undefined,
  } as Parameters<typeof handler>[0];
}

describe('deleteTask — activeAssignmentCount guard (visible)', () => {
  it('rejects deletion when activeAssignmentCount is greater than 0', async () => {
    mockReadTaskMeta.mockResolvedValue(meta({ activeAssignmentCount: 3 }));

    await expect(handler(event('t1'))).rejects.toThrow(/active|assignment/i);
    // The cascade must never run while active assignments remain.
    expect(mockCascade).not.toHaveBeenCalled();
  });

  it('allows deletion when activeAssignmentCount is 0', async () => {
    mockReadTaskMeta.mockResolvedValue(meta({ activeAssignmentCount: 0 }));

    const result = (await handler(event('t1'))) as Task;
    expect(mockCascade).toHaveBeenCalledTimes(1);
    expect(result.taskId).toBe('t1');
  });

  it('allows deletion of a legacy Task with no activeAssignmentCount field (treated as 0)', async () => {
    mockReadTaskMeta.mockResolvedValue(meta()); // no activeAssignmentCount

    await handler(event('t1'));
    expect(mockCascade).toHaveBeenCalledTimes(1);
  });
});
