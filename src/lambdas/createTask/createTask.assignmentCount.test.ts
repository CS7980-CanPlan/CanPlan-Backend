// Issue #43 — a newly created Task must initialize `activeAssignmentCount` to 0 on its #META
// item, so task deletion can later be gated on a strongly-consistent counter (not an
// eventually-consistent GSI query). This is the create half of the invariant; the increment /
// decrement / delete-guard behaviour is covered by the sibling assignment + delete tests.
import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { assertCanActForUser } from '../../shared/delegation';
import { prepareCoverImageAsset, deleteS3ObjectBestEffort } from '../../shared/media';

jest.mock('../../shared/dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));
jest.mock('../../shared/delegation', () => ({ assertCanActForUser: jest.fn() }));
jest.mock('../../shared/media', () => ({
  prepareCoverImageAsset: jest.fn(),
  deleteS3ObjectBestEffort: jest.fn().mockResolvedValue(true),
}));

const mockSend = dynamo.send as jest.Mock;
const mockAssertCanAct = assertCanActForUser as jest.Mock;

beforeEach(() => {
  mockAssertCanAct.mockResolvedValue(undefined);
  // Profile GET → a default category id; any CATEGORY# GET → a valid, owned, non-deleting
  // default category; every write → {} (mirrors createTask/handler.test.ts).
  mockSend.mockImplementation(
    (cmd: { constructor: { name: string }; input: { Key?: { PK?: string; SK?: string } } }) => {
      if (cmd.constructor.name === 'GetCommand') {
        const sk = cmd.input.Key?.SK ?? '';
        const pk = cmd.input.Key?.PK ?? '';
        const owner = pk.startsWith('USER#') ? pk.slice('USER#'.length) : 'sup-1';
        if (sk === '#PROFILE') {
          return Promise.resolve({ Item: { userId: owner, defaultCategoryId: 'def-1' } });
        }
        if (sk.startsWith('CATEGORY#')) {
          return Promise.resolve({
            Item: { categoryId: 'def-1', ownerId: owner, isDefault: true, name: 'No Category', taskCount: 0 },
          });
        }
      }
      return Promise.resolve({});
    },
  );
});
afterEach(() => jest.clearAllMocks());

function makeEvent(input: Record<string, unknown>, sub = 'sup-1') {
  return {
    arguments: { input },
    info: { fieldName: 'createTask' },
    identity: { sub },
  } as unknown as Parameters<typeof handler>[0];
}

/** The Task #META item written by the create transaction. */
function writtenMeta(): Record<string, unknown> {
  const tx = mockSend.mock.calls.map((c) => c[0]).find((c) => c.input.TransactItems);
  return tx.input.TransactItems.map(
    (t: { Put?: { Item?: Record<string, unknown> } }) => t.Put?.Item,
  ).find((i: { SK?: string } | undefined) => i?.SK === '#META');
}

describe('createTask — activeAssignmentCount initialization (visible)', () => {
  it('initializes activeAssignmentCount to 0 on a newly created Task #META', async () => {
    const result = await handler(makeEvent({ title: 'T' }));
    const meta = writtenMeta();
    expect(meta.activeAssignmentCount).toBe(0);
    // And the created task carries no active assignments yet.
    expect((result as unknown as Record<string, unknown>).activeAssignmentCount ?? 0).toBe(0);
  });

  it('initializes activeAssignmentCount to 0 even when the task is created with nested steps', async () => {
    await handler(makeEvent({ title: 'T', steps: [{ text: 'a' }, { text: 'b' }] }));
    expect(writtenMeta().activeAssignmentCount).toBe(0);
  });
});
