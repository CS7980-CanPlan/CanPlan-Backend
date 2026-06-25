import { handler } from './handler';
import { generateTitledSteps } from '../../shared/stepsService';
import { persistTask } from '../../shared/task';

jest.mock('../../shared/stepsService', () => ({ generateTitledSteps: jest.fn() }));
jest.mock('../../shared/task', () => ({ persistTask: jest.fn() }));

const mockGenerate = generateTitledSteps as jest.Mock;
const mockPersist = persistTask as jest.Mock;

function makeEvent(input: Record<string, unknown>, sub: string | null = 'owner-1') {
  return { arguments: { input }, identity: sub ? { sub } : undefined } as unknown as Parameters<typeof handler>[0];
}

beforeEach(() => {
  mockGenerate.mockResolvedValue({
    title: 'Wash your hands',
    steps: [
      { text: 'Wet your hands.', citations: [{ chunkId: 'c1', title: 't', snippet: 's' }] },
      { text: 'Use soap.', citations: [] },
    ],
    usage: { inputTokens: 5, outputTokens: 9 },
  });
  mockPersist.mockImplementation(async (ownerId, input) => ({
    taskId: 'task-1',
    ownerId,
    title: input.title,
    categoryId: input.categoryId ?? 'default-cat',
    createdAt: '2026-06-25T00:00:00.000Z',
    steps: input.steps.map((s: { text: string }, i: number) => ({
      stepId: `s${i}`, taskId: 'task-1', order: i + 1, text: s.text, mediaAssets: [],
      createdAt: '2026-06-25T00:00:00.000Z',
    })),
  }));
});

afterEach(() => jest.clearAllMocks());

describe('createAiTask handler', () => {
  it('generates a titled task and persists it under the caller, dropping citations', async () => {
    const result = await handler(makeEvent({ query: 'wash my hands' }));
    expect(mockGenerate).toHaveBeenCalledWith('wash my hands');
    // persistTask called with owner from identity, AI title, and text-only steps (no citations)
    expect(mockPersist).toHaveBeenCalledWith('owner-1', {
      title: 'Wash your hands',
      categoryId: undefined,
      steps: [{ text: 'Wet your hands.' }, { text: 'Use soap.' }],
    });
    expect(result.title).toBe('Wash your hands');
    expect(result.steps).toHaveLength(2);
  });

  it('passes a supplied categoryId through to persistTask', async () => {
    await handler(makeEvent({ query: 'wash my hands', categoryId: 'cat-9' }));
    expect(mockPersist).toHaveBeenCalledWith('owner-1', expect.objectContaining({ categoryId: 'cat-9' }));
  });

  it('throws UnauthorizedError when there is no identity', async () => {
    await expect(handler(makeEvent({ query: 'x' }, null))).rejects.toThrow('Unauthorized');
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('throws ValidationError when query is empty', async () => {
    await expect(handler(makeEvent({ query: '   ' }))).rejects.toThrow('query');
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('does not persist when generation fails', async () => {
    mockGenerate.mockRejectedValue(new Error('no relevant guidance found for this task'));
    await expect(handler(makeEvent({ query: 'gibberish' }))).rejects.toThrow('no relevant guidance');
    expect(mockPersist).not.toHaveBeenCalled();
  });
});
