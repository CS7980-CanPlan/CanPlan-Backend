import { handler } from './handler';
import { bedrock } from '../../shared/bedrock';

// Mock the Bedrock client so tests never hit AWS.
jest.mock('../../shared/bedrock', () => ({
  bedrock: { send: jest.fn() },
  BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
  BEDROCK_MAX_TOKENS: 1024,
}));

const mockSend = bedrock.send as jest.Mock;

// Shape of a successful Converse response (only the fields the handler reads).
function converseResult(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

beforeEach(() => {
  mockSend.mockResolvedValue(converseResult('Hello there!'));
});

afterEach(() => {
  jest.clearAllMocks();
});

function makeEvent(input: { prompt?: string }) {
  return { arguments: { input } } as Parameters<typeof handler>[0];
}

describe('askAi handler', () => {
  it('returns the model response text, model id, and token usage', async () => {
    const result = await handler(makeEvent({ prompt: 'Say hi' }));

    expect(result.text).toBe('Hello there!');
    expect(result.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('trims whitespace from the prompt before sending', async () => {
    await handler(makeEvent({ prompt: '  What is CanPlan?  ' }));

    const command = mockSend.mock.calls[0][0];
    expect(command.input.messages[0].content[0].text).toBe('What is CanPlan?');
  });

  it('joins multiple content blocks into one string', async () => {
    mockSend.mockResolvedValue({
      output: { message: { role: 'assistant', content: [{ text: 'foo ' }, { text: 'bar' }] } },
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const result = await handler(makeEvent({ prompt: 'split' }));
    expect(result.text).toBe('foo bar');
  });

  it('throws ValidationError when prompt is missing', async () => {
    await expect(handler(makeEvent({}))).rejects.toThrow('prompt is required');
  });

  it('throws ValidationError when prompt is only whitespace', async () => {
    await expect(handler(makeEvent({ prompt: '   ' }))).rejects.toThrow('prompt is required');
  });

  it('does not call Bedrock when validation fails', async () => {
    await expect(handler(makeEvent({ prompt: '' }))).rejects.toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws when Bedrock returns an empty response', async () => {
    mockSend.mockResolvedValue({ output: { message: { role: 'assistant', content: [] } } });
    await expect(handler(makeEvent({ prompt: 'hi' }))).rejects.toThrow('empty response');
  });
});
