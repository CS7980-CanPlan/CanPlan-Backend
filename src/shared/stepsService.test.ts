import { generateTitledSteps } from './stepsService';
import { kb } from './kb';
import { bedrock } from './bedrock';

jest.mock('./kb', () => ({
  kb: { send: jest.fn() },
  KNOWLEDGE_BASE_ID: 'kb-test-123',
  RERANK_COARSE_K: 25,
  RERANK_MODEL_ARN: 'arn:aws:bedrock:us-east-1::foundation-model/cohere.rerank-v3-5:0',
  RERANK_SCORE_FLOOR: 0.3,
  RERANK_REL_RATIO: 0.5,
  RERANK_MIN_RESULTS: 2,
  RERANK_MAX_RESULTS: 5,
}));

jest.mock('./bedrock', () => ({
  bedrock: { send: jest.fn() },
  BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
  BEDROCK_MAX_TOKENS: 1024,
}));

const mockKbSend = kb.send as jest.Mock;
const mockBedrockSend = bedrock.send as jest.Mock;

function retrieveResult() {
  return {
    retrievalResults: [
      {
        content: { text: 'Wet your hands, use soap for 20 seconds.' },
        metadata: {
          chunk_id: 'hlbc-85-handwash-steps',
          title: 'Hand washing (HealthLink BC)',
          url: 'https://example.com/handwash',
        },
      },
    ],
  };
}

function rerankResult() {
  return { results: [{ index: 0, relevanceScore: 0.9 }] };
}

function converseResult(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    usage: { inputTokens: 12, outputTokens: 8 },
  };
}

/** A titled corpus result with exactly `n` steps, each citing the retrieved chunk. */
function titledSteps(n: number): string {
  const steps = Array.from({ length: n }, (_, i) => ({
    text: `Step ${i + 1}.`,
    citations: ['hlbc-85-handwash-steps'],
  }));
  return JSON.stringify({ title: 'Wash your hands', steps });
}

/** An ungrounded titled result (no citations) with `n` steps. */
function ungroundedTitledSteps(n: number): string {
  const steps = Array.from({ length: n }, (_, i) => ({ text: `Step ${i + 1}.` }));
  return JSON.stringify({ title: 'Scramble eggs', steps });
}

beforeEach(() => {
  mockKbSend.mockImplementation((command) =>
    Promise.resolve(command.constructor.name === 'RerankCommand' ? rerankResult() : retrieveResult()),
  );
  mockBedrockSend.mockResolvedValue(converseResult(titledSteps(2)));
});

afterEach(() => jest.clearAllMocks());

describe('generateTitledSteps', () => {
  it('returns corpus-grounded output (grounded true, source CORPUS) with resolved citations', async () => {
    const result = await generateTitledSteps('wash my hands', { groundingMode: 'GROUNDED_ONLY' });
    expect(result.grounded).toBe(true);
    expect(result.source).toBe('CORPUS');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].citations[0]).toEqual({
      chunkId: 'hlbc-85-handwash-steps',
      title: 'Hand washing (HealthLink BC)',
      url: 'https://example.com/handwash',
      snippet: 'Wet your hands, use soap for 20 seconds.',
    });
  });

  it('GROUNDED_ONLY throws NotFound and NEVER calls the generation model when no passage is relevant', async () => {
    mockKbSend.mockResolvedValue({ retrievalResults: [] });
    await expect(
      generateTitledSteps('gibberish', { groundingMode: 'GROUNDED_ONLY' }),
    ).rejects.toThrow('no relevant guidance');
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('defaults to GROUNDED_ONLY (no fallback) when no grounding mode is given', async () => {
    mockKbSend.mockResolvedValue({ retrievalResults: [] });
    await expect(generateTitledSteps('gibberish')).rejects.toThrow('no relevant guidance');
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('ALLOW_UNGROUNDED_FALLBACK generates ungrounded output (grounded false, source UNGROUNDED_AI, no citations)', async () => {
    mockKbSend.mockResolvedValue({ retrievalResults: [] });
    mockBedrockSend.mockResolvedValue(converseResult(ungroundedTitledSteps(3)));
    const result = await generateTitledSteps('scramble eggs', {
      groundingMode: 'ALLOW_UNGROUNDED_FALLBACK',
    });
    expect(result.grounded).toBe(false);
    expect(result.source).toBe('UNGROUNDED_AI');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.citations.length === 0)).toBe(true);
    // The generation model was called exactly once (no retrieval passages → no rerank Retrieve).
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it('returns grounded output even under ALLOW_UNGROUNDED_FALLBACK when passages are found', async () => {
    const result = await generateTitledSteps('wash my hands', {
      groundingMode: 'ALLOW_UNGROUNDED_FALLBACK',
    });
    expect(result.grounded).toBe(true);
    expect(result.source).toBe('CORPUS');
  });

  it('honors an exact requested stepCount', async () => {
    mockBedrockSend.mockResolvedValue(converseResult(titledSteps(3)));
    const result = await generateTitledSteps('wash my hands', { stepCount: 3 });
    expect(result.steps).toHaveLength(3);
  });

  it('retries once on a step-count mismatch, then succeeds', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(converseResult(titledSteps(5))) // wrong count
      .mockResolvedValueOnce(converseResult(titledSteps(3))); // retry obeys
    const result = await generateTitledSteps('wash my hands', { stepCount: 3 });
    expect(result.steps).toHaveLength(3);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it('throws after the retry still returns the wrong step count', async () => {
    mockBedrockSend.mockResolvedValue(converseResult(titledSteps(5)));
    await expect(generateTitledSteps('wash my hands', { stepCount: 3 })).rejects.toThrow(
      'expected exactly 3 steps',
    );
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it('rejects an omitted-stepCount result over the 20-step cap, retrying once then throwing', async () => {
    mockBedrockSend.mockResolvedValue(converseResult(titledSteps(21)));
    await expect(generateTitledSteps('wash my hands')).rejects.toThrow('between 1 and 20 steps');
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });
});
