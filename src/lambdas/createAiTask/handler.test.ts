import { handler } from './handler';
import { generateTitledSteps } from '../../shared/stepsService';
import * as taskModule from '../../shared/task';

jest.mock('../../shared/stepsService', () => ({ generateTitledSteps: jest.fn() }));
jest.mock('../../shared/task', () => ({ persistTask: jest.fn() }));

const mockGenerate = generateTitledSteps as jest.Mock;
const mockPersist = taskModule.persistTask as jest.Mock;

function makeEvent(
  input: Record<string, unknown>,
  sub: string | null = 'owner-1',
  groups: string[] = ['PrimaryUser'],
) {
  return {
    arguments: { input },
    identity: sub ? { sub, groups } : undefined,
  } as unknown as Parameters<typeof handler>[0];
}

beforeEach(() => {
  mockGenerate.mockResolvedValue({
    title: 'Wash your hands',
    steps: [
      { text: 'Wet your hands.', citations: [{ chunkId: 'c1', title: 't', snippet: 's' }] },
      { text: 'Use soap.', citations: [] },
    ],
    grounded: true,
    usage: { inputTokens: 5, outputTokens: 9 },
  });
});

afterEach(() => jest.clearAllMocks());

describe('createAiTask handler', () => {
  it('returns the generated title and text-only steps without persisting anything', async () => {
    const result = await handler(makeEvent({ query: 'wash my hands' }));
    expect(mockGenerate).toHaveBeenCalledWith('wash my hands', { allowFallback: false });
    // Returns the AI title and text-only steps (citations dropped, no step/task ids).
    expect(result).toEqual({
      title: 'Wash your hands',
      steps: [{ text: 'Wet your hands.' }, { text: 'Use soap.' }],
      grounded: true,
      inputTokens: 5,
      outputTokens: 9,
    });
    // Nothing is written to the database.
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('allows the ungrounded fallback only for support persons', async () => {
    await handler(makeEvent({ query: 'scramble eggs' }, 'owner-1', ['SupportPerson']));
    expect(mockGenerate).toHaveBeenCalledWith('scramble eggs', { allowFallback: true });
  });

  it('does not allow the fallback for a primary user (care recipient)', async () => {
    await handler(makeEvent({ query: 'wash my hands' }, 'owner-1', ['PrimaryUser']));
    expect(mockGenerate).toHaveBeenCalledWith('wash my hands', { allowFallback: false });
  });

  it('passes through grounded:false from an ungrounded fallback', async () => {
    mockGenerate.mockResolvedValue({
      title: 'Scramble eggs',
      steps: [{ text: 'Crack the eggs.', citations: [] }],
      grounded: false,
      usage: { inputTokens: 3, outputTokens: 7 },
    });
    const result = await handler(makeEvent({ query: 'scramble eggs' }, 'owner-1', ['SupportPerson']));
    expect(result.grounded).toBe(false);
    expect(result.steps).toEqual([{ text: 'Crack the eggs.' }]);
  });

  it('does not persist even when a categoryId is supplied', async () => {
    await handler(makeEvent({ query: 'wash my hands', categoryId: 'cat-9' }));
    expect(mockPersist).not.toHaveBeenCalled();
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

  it('fails without writing anything when generation fails', async () => {
    mockGenerate.mockRejectedValue(new Error('no relevant guidance found for this task'));
    await expect(handler(makeEvent({ query: 'gibberish' }))).rejects.toThrow('no relevant guidance');
    expect(mockPersist).not.toHaveBeenCalled();
  });
});
