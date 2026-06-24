import { runMigration } from './migrate-default-categories';
import { stepSk } from '../src/shared/keys';

interface Row {
  PK: string;
  SK: string;
  [k: string]: unknown;
}

/**
 * A mock document client: `QueryCommand`s (entityTypeIndex) return canned rows keyed by the
 * queried entityType; every other command is recorded as a "write" and resolves to {}.
 */
function mockClient(data: { categories?: Row[]; profiles?: Row[]; tasks?: Row[]; steps?: Row[] }) {
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  const byType: Record<string, Row[] | undefined> = {
    Category: data.categories,
    UserProfile: data.profiles,
    Task: data.tasks,
    TaskStep: data.steps,
  };
  const send = jest.fn((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    if (name === 'QueryCommand') {
      const t = (cmd.input.ExpressionAttributeValues as Record<string, string>)[':t'];
      return Promise.resolve({ Items: byType[t] ?? [] });
    }
    writes.push({ name, input: cmd.input });
    return Promise.resolve({});
  });
  return { client: { send } as never, writes };
}

const run = (client: never, apply: boolean) => runMigration({ client, table: 'T', apply });

beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
afterAll(() => (console.log as jest.Mock).mockRestore());

const profile = (userId: string, defaultCategoryId?: string): Row => ({
  PK: `USER#${userId}`,
  SK: '#PROFILE',
  entityType: 'UserProfile',
  userId,
  ...(defaultCategoryId ? { defaultCategoryId } : {}),
});
const category = (ownerId: string, categoryId: string, extra: Record<string, unknown> = {}): Row => ({
  PK: `USER#${ownerId}`,
  SK: `CATEGORY#${categoryId}`,
  entityType: 'Category',
  ownerId,
  categoryId,
  ...extra,
});
const defaultCategory = (ownerId: string, categoryId: string, taskCount?: number): Row =>
  category(ownerId, categoryId, { isDefault: true, name: 'No Category', ...(taskCount !== undefined ? { taskCount } : {}) });
const task = (taskId: string, ownerId: string, extra: Record<string, unknown> = {}): Row => ({
  PK: `TASK#${taskId}`,
  SK: '#META',
  entityType: 'Task',
  taskId,
  ownerId,
  ...extra,
});

describe('migration — dry run', () => {
  it('reports planned changes without issuing any writes', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u1')], // missing default
      categories: [],
      tasks: [task('t1', 'u1', { categoryId: 'NO_CATEGORY' })],
      steps: [{ PK: 'TASK#t1', SK: 'STEP#001', entityType: 'TaskStep', stepId: 's1' }],
    });
    const report = await run(client, false);
    expect(writes).toHaveLength(0);
    expect(report.defaultsCreated).toBe(1);
    expect(report.tasksReparented).toBe(1);
    expect(report.stepsRekeyed).toBe(1);
  });
});

describe('migration — apply', () => {
  it('creates a missing default, sets the pointer, reparents a NO_CATEGORY task, and counts it', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u1')],
      categories: [],
      tasks: [task('t1', 'u1', { categoryId: 'NO_CATEGORY' })],
    });
    const report = await run(client, true);
    expect(report.defaultsCreated).toBe(1);
    expect(report.tasksReparented).toBe(1);

    // The create transaction: a new default category (taskCount reflecting the reparented
    // task) + the profile pointer.
    const createTx = writes.find((w) => w.name === 'TransactWriteCommand')!;
    const items = createTx.input.TransactItems as Array<Record<string, { Item?: Record<string, unknown>; UpdateExpression?: string }>>;
    const catItem = items[0].Put!.Item!;
    expect(catItem.name).toBe('No Category');
    expect(catItem.color).toBe('#64748B');
    expect(catItem.isDefault).toBe(true);
    expect(catItem.taskCount).toBe(1);
    const newId = catItem.categoryId as string;
    expect(items[1].Update!.UpdateExpression).toContain('defaultCategoryId = :id');

    // The task is reparented to the new default id.
    const taskUpdate = writes.find(
      (w) => w.name === 'UpdateCommand' && (w.input.Key as { PK: string }).PK === 'TASK#t1',
    )!;
    expect((taskUpdate.input.ExpressionAttributeValues as Record<string, unknown>)[':cat']).toBe(newId);
  });

  it('backfills taskCount on an existing default with the wrong count', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u2', 'd2')],
      categories: [defaultCategory('u2', 'd2', 0)],
      tasks: [task('t2', 'u2', { categoryId: 'd2' })],
    });
    const report = await run(client, true);
    expect(report.defaultsCreated).toBe(0);
    expect(report.defaultsRepaired).toBe(0);
    expect(report.taskCountsBackfilled).toBe(1);
    const backfill = writes.find(
      (w) => w.name === 'UpdateCommand' && (w.input.Key as { SK: string }).SK === 'CATEGORY#d2',
    )!;
    expect((backfill.input.ExpressionAttributeValues as Record<string, unknown>)[':c']).toBe(1);
  });

  it('repairs an invalid pointer to an existing default without creating a second one', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u4', 'bogus')],
      categories: [defaultCategory('u4', 'd4', 0)],
      tasks: [],
    });
    const report = await run(client, true);
    expect(report.defaultsCreated).toBe(0);
    expect(report.defaultsRepaired).toBe(1);
    expect(writes.some((w) => w.name === 'TransactWriteCommand')).toBe(false); // no create
    const repair = writes.find((w) => w.name === 'UpdateCommand' && (w.input.Key as { SK: string }).SK === '#PROFILE')!;
    expect((repair.input.ExpressionAttributeValues as Record<string, unknown>)[':id']).toBe('d4');
  });

  it('strips a legacy Task status attribute', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u6', 'd6')],
      categories: [defaultCategory('u6', 'd6', 1)],
      tasks: [task('t6', 'u6', { categoryId: 'd6', status: 'ACTIVE' })],
    });
    const report = await run(client, true);
    expect(report.statusStripped).toBe(1);
    const upd = writes.find((w) => w.name === 'UpdateCommand' && (w.input.Key as { PK: string }).PK === 'TASK#t6')!;
    expect(upd.input.UpdateExpression).toContain('REMOVE #status');
    expect(upd.input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
  });

  it('rekeys an order-based step to STEP#<stepId> and leaves stable keys alone', async () => {
    const { client, writes } = mockClient({
      profiles: [],
      categories: [],
      tasks: [],
      steps: [
        { PK: 'TASK#tt', SK: 'STEP#001', entityType: 'TaskStep', stepId: 's1', text: 'x' },
        { PK: 'TASK#tt', SK: stepSk('s2'), entityType: 'TaskStep', stepId: 's2' },
      ],
    });
    const report = await run(client, true);
    expect(report.stepsRekeyed).toBe(1);
    const tx = writes.find((w) => w.name === 'TransactWriteCommand')!;
    const items = tx.input.TransactItems as Array<Record<string, { Item?: Row; Key?: Row }>>;
    expect(items[0].Put!.Item!.SK).toBe(stepSk('s1'));
    expect(items[1].Delete!.Key!.SK).toBe('STEP#001');
  });
});

describe('migration — exactly one default', () => {
  // Two valid defaults for u5; pointer targets the non-lowest one; the surviving default's
  // task is preserved on it. d5a < d5b, so d5a is THE default and d5b is demoted.
  const dupData = () => ({
    profiles: [profile('u5', 'd5b')],
    categories: [defaultCategory('u5', 'd5a', 0), defaultCategory('u5', 'd5b', 1)],
    tasks: [task('t5', 'u5', { categoryId: 'd5b', stepCount: 0, stepVersion: 1, nextStepOrder: 1 })],
  });

  it('reports duplicates without writing in dry-run', async () => {
    const { client, writes } = mockClient(dupData());
    const report = await run(client, false);
    expect(report.duplicateDefaults).toBe(1);
    expect(report.duplicatesRepaired).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('keeps the lowest-id default, demotes the extra to a non-reserved category, repairs the pointer', async () => {
    const { client, writes } = mockClient(dupData());
    const report = await run(client, true);
    expect(report.duplicatesRepaired).toBe(1);

    // d5b (the non-lowest) is demoted: isDefault → false, renamed to a non-reserved name.
    const demotion = writes.find(
      (w) => w.name === 'UpdateCommand' && (w.input.Key as { SK: string }).SK === 'CATEGORY#d5b',
    )!;
    const vals = demotion.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(vals[':false']).toBe(false);
    expect(String(vals[':name'])).toMatch(/^Recovered Category /);
    // The pointer is repaired to the surviving default d5a (deterministic: lowest id).
    const pointer = writes.find(
      (w) => w.name === 'UpdateCommand' && (w.input.Key as { SK: string }).SK === '#PROFILE',
    )!;
    expect((pointer.input.ExpressionAttributeValues as Record<string, unknown>)[':id']).toBe('d5a');
    expect(report.duplicateDefaultRepairs).toEqual([
      {
        ownerId: 'u5',
        keptCategoryId: 'd5a',
        demotedCategoryId: 'd5b',
        newName: 'Recovered Category d5b',
      },
    ]);
  });

  it('creates a canonical default and demotes a legacy default with a non-canonical name', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u7', 'legacy')],
      categories: [category('u7', 'legacy', { isDefault: true, name: 'no category', taskCount: 0 })],
      tasks: [],
    });
    const report = await run(client, true);

    expect(report.defaultsCreated).toBe(1);
    // The created default and profile pointer are written together in one transaction.
    expect(report.defaultsRepaired).toBe(0);
    expect(report.duplicatesRepaired).toBe(1);
    const demotion = writes.find(
      (w) => w.name === 'UpdateCommand' && (w.input.Key as { SK: string }).SK === 'CATEGORY#legacy',
    )!;
    expect((demotion.input.ExpressionAttributeValues as Record<string, unknown>)[':false']).toBe(false);
    expect((demotion.input.ExpressionAttributeValues as Record<string, unknown>)[':name']).toBe(
      'Recovered Category legacy',
    );
    const create = writes.find((w) => w.name === 'TransactWriteCommand')!;
    const createdId = (create.input.TransactItems as Array<Record<string, { Item?: Row }>>)[0].Put!.Item!
      .categoryId as string;
    expect(report.duplicateDefaultRepairs[0].keptCategoryId).toBe(createdId);
  });

  it('is idempotent after repair (one default, demoted extra renamed) — no further changes', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u5', 'd5a')],
      categories: [
        defaultCategory('u5', 'd5a', 0), // surviving default, no tasks
        category('u5', 'd5b', { isDefault: false, name: 'Recovered Category d5b', taskCount: 1 }),
      ],
      tasks: [task('t5', 'u5', { categoryId: 'd5b', stepCount: 0, stepVersion: 1, nextStepOrder: 1 })],
    });
    const report = await run(client, true);
    expect(report.duplicateDefaults).toBe(0);
    expect(report.duplicatesRepaired).toBe(0);
    expect(report.defaultsRepaired).toBe(0);
    expect(report.taskCountsBackfilled).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

describe('migration — step metadata backfill', () => {
  it('backfills stepCount/nextStepOrder/stepVersion on a task lacking metadata, from its steps', async () => {
    const { client, writes } = mockClient({
      profiles: [profile('u', 'd')],
      categories: [defaultCategory('u', 'd', 1)],
      tasks: [task('t', 'u', { categoryId: 'd' })], // no step metadata
      steps: [
        { PK: 'TASK#t', SK: stepSk('s1'), entityType: 'TaskStep', stepId: 's1', taskId: 't', order: 1 },
        { PK: 'TASK#t', SK: stepSk('s2'), entityType: 'TaskStep', stepId: 's2', taskId: 't', order: 2 },
      ],
    });
    const report = await run(client, true);
    expect(report.stepMetaBackfilled).toBe(1);
    const backfill = writes.find(
      (w) =>
        w.name === 'UpdateCommand' &&
        (w.input.Key as { PK: string }).PK === 'TASK#t' &&
        String(w.input.UpdateExpression).includes('stepVersion'),
    )!;
    const vals = backfill.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(vals[':c']).toBe(2); // stepCount = number of steps
    expect(vals[':o']).toBe(3); // nextStepOrder = maxOrder + 1
    expect(vals[':v']).toBe(1); // stepVersion baseline
  });
});

describe('migration — idempotency', () => {
  const currentData = () => ({
    profiles: [profile('u', 'd')],
    categories: [defaultCategory('u', 'd', 1)],
    tasks: [task('t', 'u', { categoryId: 'd', stepCount: 1, stepVersion: 1, nextStepOrder: 2 })],
    steps: [
      { PK: 'TASK#t', SK: stepSk('s'), entityType: 'TaskStep', stepId: 's', taskId: 't', order: 1 },
    ],
  });

  it('plans (and writes) nothing when everything is already current', async () => {
    const { client, writes } = mockClient(currentData());
    const dry = await run(client, false);
    expect(dry.defaultsCreated + dry.defaultsRepaired + dry.tasksReparented).toBe(0);
    expect(dry.statusStripped + dry.taskCountsBackfilled + dry.stepsRekeyed).toBe(0);
    expect(dry.duplicatesRepaired + dry.stepMetaBackfilled).toBe(0);

    const { client: client2, writes: writes2 } = mockClient(currentData());
    await run(client2, true);
    expect(writes).toHaveLength(0);
    expect(writes2).toHaveLength(0);
  });
});
