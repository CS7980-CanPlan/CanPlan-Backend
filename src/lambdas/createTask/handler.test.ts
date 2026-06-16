import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';

// Mock the DynamoDB document client so tests never hit AWS.
jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => {
  mockSend.mockResolvedValue({});
});

afterEach(() => {
  jest.clearAllMocks();
});

type Input = Parameters<typeof handler>[0]['arguments']['input'];

function makeEvent(input: Partial<Input>) {
  return { arguments: { input }, info: { fieldName: 'createTask' } } as Parameters<typeof handler>[0];
}

/** Pull the items out of the single TransactWrite the handler issues. */
function writtenItems(): Array<Record<string, unknown>> {
  const cmd = mockSend.mock.calls[0][0];
  return cmd.input.TransactItems.map((t: { Put: { Item: Record<string, unknown> } }) => t.Put.Item);
}

describe('createTask handler', () => {
  it('writes a Task #META item with PK=TASK#<taskId>, SK=#META and the owner/createdAt GSI fields', async () => {
    const result = await handler(
      makeEvent({ ownerId: 'sup-1', title: 'Make tea', categoryId: 'cat-1', description: 'green tea' }),
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const items = writtenItems();
    const meta = items.find((i) => i.SK === '#META')!;

    expect(meta.PK).toBe(`TASK#${result.taskId}`);
    expect(meta.SK).toBe('#META');
    expect(meta.entityType).toBe('Task');
    // taskOwnerIndex fields must be present on the Task item.
    expect(meta.ownerId).toBe('sup-1');
    expect(typeof meta.createdAt).toBe('string');
    expect(meta.title).toBe('Make tea');
    expect(meta.status).toBe('DRAFT');
    // Steps are stored as separate items, never embedded on the Task item.
    expect(meta.steps).toBeUndefined();
  });

  it('writes each nested step as its own item with zero-padded STEP#001, STEP#002, STEP#003 keys', async () => {
    const result = await handler(
      makeEvent({
        ownerId: 'sup-1',
        title: 'Brush teeth',
        steps: [{ text: 'Wet the brush' }, { text: 'Add toothpaste' }, { text: 'Brush' }],
      }),
    );

    const steps = writtenItems().filter((i) => i.entityType === 'TaskStep');
    expect(steps.map((s) => s.SK)).toEqual(['STEP#001', 'STEP#002', 'STEP#003']);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3]);
    for (const step of steps) {
      expect(step.PK).toBe(`TASK#${result.taskId}`);
      expect(step.taskId).toBe(result.taskId);
      expect(typeof step.stepId).toBe('string');
    }
    // Returned task carries the steps it just wrote.
    expect(result.steps).toHaveLength(3);
  });

  it('generates a unique taskId and a stepId per step', async () => {
    const result = await handler(makeEvent({ ownerId: 'o', title: 'T', steps: [{ text: 'a' }, { text: 'b' }] }));
    expect(result.taskId).toMatch(/[0-9a-f-]{36}/);
    const stepIds = result.steps!.map((s) => s.stepId);
    expect(new Set(stepIds).size).toBe(2);
  });

  it('writes only the Task item when no steps are provided', async () => {
    await handler(makeEvent({ ownerId: 'o', title: 'No steps' }));
    expect(writtenItems()).toHaveLength(1);
  });

  it('honors a provided status', async () => {
    const result = await handler(makeEvent({ ownerId: 'o', title: 'T', status: 'ACTIVE' }));
    expect(result.status).toBe('ACTIVE');
  });

  it('throws ValidationError when ownerId is missing', async () => {
    await expect(handler(makeEvent({ title: 'T' }))).rejects.toThrow('ownerId is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when title is missing', async () => {
    await expect(handler(makeEvent({ ownerId: 'o' }))).rejects.toThrow('title is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when a step has empty text', async () => {
    await expect(
      handler(makeEvent({ ownerId: 'o', title: 'T', steps: [{ text: '  ' }] })),
    ).rejects.toThrow('step 1: text is required');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
