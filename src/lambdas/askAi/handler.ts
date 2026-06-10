import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrock, BEDROCK_MODEL_ID, BEDROCK_MAX_TOKENS } from '../../shared/bedrock';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, AskAiInput, AiResponse } from '../../shared/types';

export const handler = async (event: AppSyncEvent<{ input: AskAiInput }>): Promise<AiResponse> => {
  const { input } = event.arguments;
  const prompt = input?.prompt?.trim();

  if (!prompt) {
    throw new ValidationError('prompt is required and cannot be empty');
  }

  // Converse gives a model-agnostic message shape, so we don't hand-build the
  // anthropic_version JSON body that raw InvokeModel would require.
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: BEDROCK_MAX_TOKENS },
    }),
  );

  // A turn can come back as several text blocks; join them into one string.
  const text = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Bedrock returned an empty response');
  }

  return {
    text,
    model: BEDROCK_MODEL_ID,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  };
};
