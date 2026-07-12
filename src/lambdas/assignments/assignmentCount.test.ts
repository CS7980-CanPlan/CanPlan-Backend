// Issue #43 — creating an ACTIVE TaskAssignment must increment the source Task's
// activeAssignmentCount, and ending an active assignment must decrement it. These are the
// observable-counter halves of the invariant that lets deleteTask gate on a strongly-consistent
// count instead of an eventually-consistent GSI query. (Atomicity, duplicate protection, and
// non-negativity are exercised by the issue-43 hidden suite.)
import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { queryAllItems } from '../../shared/batch';
import { assertCanActForUser } from '../../shared/delegation';

jest.mock('../../shared/dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));
jest.mock('../../shared/batch', () => ({ queryAllItems: jest.fn() }));
jest.mock('../../shared/delegation', () => ({ assertCanActForUser: jest.fn() }));

const mockSend = dynamo.send as jest.Mock;
const mockQueryAllItems = queryAllItems as jest.Mock;
const mockAssertCanAct = assertCanActForUser as jest.Mock;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose mock helpers
type Rec = Record<string, any>;
let db: { assignment?: Rec; taskMeta?: Rec } = {};

function event(fieldName: string, args: Record<string, unknown>, sub = 'assigner-1') {
  return { arguments: args, info: { fieldName }, identity: { sub } } as Parameters<typeof handler>[0];
}

beforeEach(() => {
  db = {};
  mockQueryAllItems.mockResolvedValue([]);
  mockAssertCanAct.mockResolvedValue('assigner-1');
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'GetCommand') {
      const sk: string = input.Key.SK;
      if (sk === '#META') return Promise.resolve({ Item: db.taskMeta });
      if (sk.startsWith('TASK_ASSIGNMENT#')) return Promise.resolve({ Item: db.assignment });
      return Promise.resolve({});
    }
    if (name === 'UpdateCommand') return Promise.resolve({ Attributes: { ...(db.assignment ?? {}) } });
    return Promise.resolve({});
  });
});
afterEach(() => jest.clearAllMocks());

// ── transaction inspection ────────────────────────────────────────────────────
const txCommands = (): Rec[] =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.input.TransactItems).map((c) => c.input);
const allTxItems = (): Rec[] => txCommands().flatMap((t) => t.TransactItems as Rec[]);

/**
 * Signed delta a TransactWrite item applies to the #META activeAssignmentCount (0 if none).
 * Handles both the `SET x = x ± :v` and `ADD x :±v` idioms (the #META update touches only the
 * counter + updatedAt, so the sole arithmetic operator is the counter's).
 */
function counterDelta(it: Rec): number {
  const u = it.Update;
  if (!u || u.Key?.SK !== '#META') return 0;
  const expr = String(u.UpdateExpression ?? '');
  if (!expr.includes('activeAssignmentCount')) return 0;
  const vals = Object.values(u.ExpressionAttributeValues ?? {});
  const setSub = /-\s*:/.test(expr); // "... - :value"
  const setAdd = /\+\s*:/.test(expr); // "... + :value"
  if (setSub && !setAdd) return -1;
  if (setAdd && !setSub) return 1;
  // ADD idiom (no +/- operator): sign carried by the numeric value.
  if (vals.includes(-1)) return -1;
  if (vals.includes(1)) return 1;
  return 0;
}
const metaCounterItem = (): Rec | undefined => allTxItems().find((it) => counterDelta(it) !== 0);

const ONE_TIME_INPUT = {
  taskId: 't1',
  userId: 'u1',
  scheduleType: 'ONE_TIME',
  scheduledFor: '2099-07-01T09:00:00Z',
  timezone: 'UTC',
};

describe('createTaskAssignment — increments activeAssignmentCount (visible)', () => {
  it('increments the source Task activeAssignmentCount when an active assignment is created', async () => {
    db.taskMeta = { taskId: 't1', ownerId: 'assigner-1', activeAssignmentCount: 0 };

    await handler(event('createTaskAssignment', { input: ONE_TIME_INPUT }));

    const counter = metaCounterItem();
    expect(counter).toBeDefined();
    expect(counter!.Update.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(counterDelta(counter!)).toBe(1);
  });
});

describe('endTaskAssignment — decrements activeAssignmentCount (visible)', () => {
  it('decrements the source Task activeAssignmentCount when an active assignment is fully ended', async () => {
    db.assignment = {
      assignmentId: 'a1',
      taskId: 't1',
      userId: 'u1',
      scheduleType: 'ONE_TIME',
      scheduledFor: '2099-07-02T09:00:00Z',
      timezone: 'UTC',
      active: true,
      activeTaskAssignmentTaskId: 't1',
      assignedAt: 'x',
      createdAt: 'x',
    };

    await handler(
      event('endTaskAssignment', {
        input: { userId: 'u1', assignmentId: 'a1', effectiveDate: '2099-07-02' },
      }),
    );

    const counter = metaCounterItem();
    expect(counter).toBeDefined();
    expect(counter!.Update.Key).toEqual({ PK: 'TASK#t1', SK: '#META' });
    expect(counterDelta(counter!)).toBe(-1);
  });
});
