import { handler } from './handler';
import { kb } from '../../shared/kb';
import { bedrock } from '../../shared/bedrock';

jest.mock('../../shared/kb', () => ({
  kb: { send: jest.fn() },
  KNOWLEDGE_BASE_ID: 'kb-test-123',
  RETRIEVAL_TOP_K: 4,
}));

jest.mock('../../shared/bedrock', () => ({
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

function converseResult(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    usage: { inputTokens: 12, outputTokens: 8 },
  };
}

const goodSteps = '{"steps":[{"text":"Wet your hands.","citations":["hlbc-85-handwash-steps"]}]}';

beforeEach(() => {
  mockKbSend.mockResolvedValue(retrieveResult());
  mockBedrockSend.mockResolvedValue(converseResult(goodSteps));
});

afterEach(() => jest.clearAllMocks());

function makeEvent(input: Record<string, unknown>) {
  return { arguments: { input } } as unknown as Parameters<typeof handler>[0];
}

describe('generateTaskSteps handler', () => {
  it('returns resolved steps, model id, and token usage', async () => {
    const result = await handler(makeEvent({ userId: 'u1', query: 'wash my hands' }));
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].text).toBe('Wet your hands.');
    expect(result.steps[0].citations[0]).toEqual({
      chunkId: 'hlbc-85-handwash-steps',
      title: 'Hand washing (HealthLink BC)',
      url: 'https://example.com/handwash',
      snippet: 'Wet your hands, use soap for 20 seconds.',
    });
    expect(result.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(8);
  });

  it('calls Retrieve with the KB id, the query, and top-K', async () => {
    await handler(makeEvent({ userId: 'u1', query: 'wash my hands' }));
    const cmd = mockKbSend.mock.calls[0][0];
    expect(cmd.input.knowledgeBaseId).toBe('kb-test-123');
    expect(cmd.input.retrievalQuery.text).toBe('wash my hands');
    expect(cmd.input.retrievalConfiguration.vectorSearchConfiguration.numberOfResults).toBe(4);
  });

  it('drops citations whose chunk_id is not in the retrieved set', async () => {
    mockBedrockSend.mockResolvedValue(
      converseResult('{"steps":[{"text":"Hmm.","citations":["ghost-id"]}]}'),
    );
    const result = await handler(makeEvent({ userId: 'u1', query: 'wash my hands' }));
    expect(result.steps[0].citations).toEqual([]);
  });

  it('retries once on malformed JSON, then succeeds', async () => {
    mockBedrockSend
      .mockResolvedValueOnce(converseResult('not json'))
      .mockResolvedValueOnce(converseResult(goodSteps));
    const result = await handler(makeEvent({ userId: 'u1', query: 'wash my hands' }));
    expect(result.steps).toHaveLength(1);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it('throws a parse error after the retry also fails', async () => {
    mockBedrockSend.mockResolvedValue(converseResult('still not json'));
    await expect(handler(makeEvent({ userId: 'u1', query: 'wash my hands' }))).rejects.toThrow(
      'could not parse steps',
    );
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it('throws ValidationError when userId is missing', async () => {
    await expect(handler(makeEvent({ query: 'wash my hands' }))).rejects.toThrow('userId');
    expect(mockKbSend).not.toHaveBeenCalled();
  });

  it('throws ValidationError when query is empty', async () => {
    await expect(handler(makeEvent({ userId: 'u1', query: '   ' }))).rejects.toThrow('query');
    expect(mockKbSend).not.toHaveBeenCalled();
  });

  it('throws when Retrieve returns zero passages', async () => {
    mockKbSend.mockResolvedValue({ retrievalResults: [] });
    await expect(handler(makeEvent({ userId: 'u1', query: 'wash my hands' }))).rejects.toThrow(
      'no relevant guidance',
    );
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });
});
