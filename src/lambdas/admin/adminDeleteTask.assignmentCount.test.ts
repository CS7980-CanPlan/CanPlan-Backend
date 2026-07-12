// Issue #43 — adminDeleteTask (SystemAdmin, no ownership check) must apply the same deletion
// guard as the owner path: allow deletion only when the Task's activeAssignmentCount is 0 (or
// the field is absent on a legacy row), based on the strongly-consistent #META counter.
import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { readTaskMeta, deleteTaskCascade } from '../../shared/taskCascade';
import type { Task } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));
jest.mock('../../shared/cognito', () => ({
  cognito: { send: jest.fn() },
  USER_POOL_ID: 'pool-test',
  SYSTEM_ADMIN_GROUP: 'SystemAdmin',
  BASE_ROLE_GROUPS: [],
  BASE_ROLE_TO_GROUP: {},
  findCognitoUsernameBySub: jest.fn(),
  listGroupsForUser: jest.fn(),
}));
jest.mock('../../shared/batch', () => ({
  batchDelete: jest.fn(),
  queryAllKeys: jest.fn().mockResolvedValue([]),
  queryAllItems: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../shared/taskCascade', () => ({ readTaskMeta: jest.fn(), deleteTaskCascade: jest.fn() }));
jest.mock('../../shared/assignment', () => ({
  assertNoActiveAssignmentsForTask: jest.fn().mockResolvedValue(undefined),
  countActiveAssignmentsForTask: jest.fn().mockResolvedValue(0),
  queryActiveAssignmentKeysForTask: jest.fn().mockResolvedValue([]),
}));

const mockSend = dynamo.send as jest.Mock;
const mockReadTaskMeta = readTaskMeta as jest.Mock;
const mockCascade = deleteTaskCascade as jest.Mock;

const ADMIN = { groups: ['SystemAdmin'], sub: 'admin-self' };

const meta = (extra: Record<string, unknown> = {}): Task =>
  ({ taskId: 't1', ownerId: 'o1', title: 'T', categoryId: 'cat-1', createdAt: 'c', ...extra } as Task);

let currentMeta: Task | undefined;

beforeEach(() => {
  currentMeta = meta({ activeAssignmentCount: 0 });
  // Serve the #META whether the guard reads it via readTaskMeta or a direct GetCommand.
  mockReadTaskMeta.mockImplementation(async () => currentMeta);
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: { Key?: { SK?: string } } }) => {
    if (cmd.constructor.name === 'GetCommand' && cmd.input.Key?.SK === '#META') {
      return Promise.resolve({ Item: currentMeta });
    }
    return Promise.resolve({});
  });
  mockCascade.mockImplementation(async (id: string) => meta({ taskId: id }));
});
afterEach(() => jest.clearAllMocks());

function event(taskId: string, identity: unknown = ADMIN) {
  return { arguments: { taskId }, info: { fieldName: 'adminDeleteTask' }, identity } as Parameters<typeof handler>[0];
}

describe('adminDeleteTask — activeAssignmentCount guard (visible)', () => {
  it('rejects deletion when activeAssignmentCount is greater than 0', async () => {
    currentMeta = meta({ activeAssignmentCount: 2 });

    await expect(handler(event('t1'))).rejects.toThrow(/active|assignment/i);
    expect(mockCascade).not.toHaveBeenCalled();
  });

  it('allows deletion when activeAssignmentCount is 0', async () => {
    currentMeta = meta({ activeAssignmentCount: 0 });

    await handler(event('t1'));
    expect(mockCascade).toHaveBeenCalledWith('t1');
  });

  it('allows deletion of a legacy Task with no activeAssignmentCount field (treated as 0)', async () => {
    currentMeta = meta(); // no activeAssignmentCount

    await handler(event('t1'));
    expect(mockCascade).toHaveBeenCalledWith('t1');
  });
});
