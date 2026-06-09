import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';

// Mock the DynamoDB document client so tests never hit AWS.
jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TASKS_TABLE: 'CanPlanTasks-dev',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => {
  mockSend.mockResolvedValue({});
});

afterEach(() => {
  jest.clearAllMocks();
});

function makeEvent(input: { title?: string; description?: string }) {
  return { arguments: { input } } as Parameters<typeof handler>[0];
}

describe('createTask handler', () => {
  it('creates a task and returns it', async () => {
    const result = await handler(makeEvent({ title: 'Buy groceries', description: 'Milk and eggs' }));

    expect(result.title).toBe('Buy groceries');
    expect(result.description).toBe('Milk and eggs');
    expect(result.taskId).toBeDefined();
    expect(result.createdAt).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('trims whitespace from title', async () => {
    const result = await handler(makeEvent({ title: '  Clean desk  ' }));
    expect(result.title).toBe('Clean desk');
  });

  it('throws ValidationError when title is missing', async () => {
    await expect(handler(makeEvent({}))).rejects.toThrow('title is required');
  });

  it('throws ValidationError when title is only whitespace', async () => {
    await expect(handler(makeEvent({ title: '   ' }))).rejects.toThrow('title is required');
  });

  it('does not call DynamoDB when validation fails', async () => {
    await expect(handler(makeEvent({ title: '' }))).rejects.toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
