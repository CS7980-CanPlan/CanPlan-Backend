import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { kb, KNOWLEDGE_BASE_ID, RETRIEVAL_TOP_K } from '../../shared/kb';
import { bedrock, BEDROCK_MODEL_ID, BEDROCK_MAX_TOKENS } from '../../shared/bedrock';
import { ValidationError } from '../../shared/response';
import { SYSTEM_PROMPT, buildStepsPrompt, parseSteps, toTaskSteps } from '../../shared/steps';
import type {
  AppSyncEvent,
  GenerateTaskStepsInput,
  RetrievedPassage,
  TaskStepsResponse,
} from '../../shared/types';

export const handler = async (
  event: AppSyncEvent<{ input: GenerateTaskStepsInput }>,
): Promise<TaskStepsResponse> => {
  const { input } = event.arguments;
  const userId = input?.userId?.trim();
  const query = input?.query?.trim();

  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!query) throw new ValidationError('query is required and cannot be empty');

  // 1. Retrieve top-K passages over the WHOLE corpus (unscoped — see spec rationale).
  const retrieval = await kb.send(
    new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: RETRIEVAL_TOP_K },
      },
    }),
  );

  const passages: RetrievedPassage[] = (retrieval.retrievalResults ?? []).map((r) => ({
    chunkId: String(r.metadata?.chunk_id ?? ''),
    text: r.content?.text ?? '',
    title: String(r.metadata?.title ?? ''),
    url: r.metadata?.url ? String(r.metadata.url) : undefined,
  }));

  if (passages.length === 0) {
    throw new Error('no relevant guidance found for this task');
  }

  // 2. Build the Round-3 prompt and generate; retry once on malformed JSON.
  const userPrompt = buildStepsPrompt(query, passages);
  const { raw, usage } = await converse(userPrompt);
  let rawSteps;
  try {
    rawSteps = parseSteps(raw);
  } catch {
    const retry = await converse(`${userPrompt}\n\nReturn valid JSON only, no prose.`);
    rawSteps = parseSteps(retry.raw); // throws on a second failure — mirrors prototype GeneratorError
  }

  // 3. Resolve citations against the retrieved set (unknown ids dropped in toTaskSteps).
  const steps = toTaskSteps(rawSteps, passages);

  // 4. Structured CloudWatch log (#18 requirement). userId/context are audit-only.
  console.log(
    JSON.stringify({
      event: 'generateTaskSteps',
      userId,
      query,
      role: input.context?.role,
      organizationId: input.context?.organizationId,
      retrievedPassages: passages.length,
      stepCount: steps.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }),
  );

  return { steps, model: BEDROCK_MODEL_ID, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens };
};

async function converse(prompt: string) {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: BEDROCK_MAX_TOKENS },
    }),
  );
  const raw = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  return { raw, usage: response.usage };
}
