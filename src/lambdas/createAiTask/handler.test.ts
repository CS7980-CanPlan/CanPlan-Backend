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
    source: 'CORPUS',
    usage: { inputTokens: 5, outputTokens: 9 },
  });
});

afterEach(() => jest.clearAllMocks());

describe('createAiTask handler', () => {
  it('returns the generated title, steps with citations, and source without persisting', async () => {
    const result = await handler(makeEvent({ query: 'wash my hands' }));
    // Default grounding mode is GROUNDED_ONLY; no requested step count.
    expect(mockGenerate).toHaveBeenCalledWith('wash my hands', {
      groundingMode: 'GROUNDED_ONLY',
      stepCount: undefined,
    });
    // Corpus-generated: grounded true, source CORPUS, citations preserved per step.
    expect(result).toEqual({
      title: 'Wash your hands',
      steps: [
        { text: 'Wet your hands.', citations: [{ chunkId: 'c1', title: 't', snippet: 's' }] },
        { text: 'Use soap.', citations: [] },
      ],
      grounded: true,
      source: 'CORPUS',
      inputTokens: 5,
      outputTokens: 9,
    });
    // Nothing is written to the database.
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('passes ALLOW_UNGROUNDED_FALLBACK through for any authenticated user (not only SupportPerson)', async () => {
    await handler(
      makeEvent({ query: 'scramble eggs', groundingMode: 'ALLOW_UNGROUNDED_FALLBACK' }, 'owner-1', [
        'PrimaryUser',
      ]),
    );
    expect(mockGenerate).toHaveBeenCalledWith('scramble eggs', {
      groundingMode: 'ALLOW_UNGROUNDED_FALLBACK',
      stepCount: undefined,
    });
  });

  it('no longer treats the SupportPerson group as special — mode still defaults to GROUNDED_ONLY', async () => {
    await handler(makeEvent({ query: 'wash my hands' }, 'owner-1', ['SupportPerson']));
    expect(mockGenerate).toHaveBeenCalledWith('wash my hands', {
      groundingMode: 'GROUNDED_ONLY',
      stepCount: undefined,
    });
  });

  it('returns source UNGROUNDED_AI, grounded false, and empty citations for an ungrounded fallback', async () => {
    mockGenerate.mockResolvedValue({
      title: 'Scramble eggs',
      steps: [{ text: 'Crack the eggs.', citations: [] }],
      grounded: false,
      source: 'UNGROUNDED_AI',
      usage: { inputTokens: 3, outputTokens: 7 },
    });
    const result = await handler(
      makeEvent({ query: 'scramble eggs', groundingMode: 'ALLOW_UNGROUNDED_FALLBACK' }),
    );
    expect(result.grounded).toBe(false);
    expect(result.source).toBe('UNGROUNDED_AI');
    expect(result.steps).toEqual([{ text: 'Crack the eggs.', citations: [] }]);
  });

  it('accepts stepCount 1 and 20 and passes them through', async () => {
    await handler(makeEvent({ query: 'wash my hands', stepCount: 1 }));
    expect(mockGenerate).toHaveBeenCalledWith('wash my hands', {
      groundingMode: 'GROUNDED_ONLY',
      stepCount: 1,
    });
    await handler(makeEvent({ query: 'wash my hands', stepCount: 20 }));
    expect(mockGenerate).toHaveBeenLastCalledWith('wash my hands', {
      groundingMode: 'GROUNDED_ONLY',
      stepCount: 20,
    });
  });

  it.each([0, -1, 21, 2.5])('throws ValidationError for invalid stepCount %p', async (stepCount) => {
    await expect(handler(makeEvent({ query: 'wash my hands', stepCount }))).rejects.toThrow(
      'stepCount',
    );
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws ValidationError for an unknown groundingMode', async () => {
    await expect(
      handler(makeEvent({ query: 'wash my hands', groundingMode: 'NOPE' })),
    ).rejects.toThrow('groundingMode');
    expect(mockGenerate).not.toHaveBeenCalled();
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
