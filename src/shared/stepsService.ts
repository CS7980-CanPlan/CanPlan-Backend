import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { kb, KNOWLEDGE_BASE_ID, RERANK_COARSE_K } from './kb';
import { bedrock, BEDROCK_MODEL_ID, BEDROCK_MAX_TOKENS } from './bedrock';
import {
  SYSTEM_PROMPT,
  buildStepsPrompt,
  buildTitledStepsPrompt,
  parseSteps,
  parseTitledSteps,
  toTaskSteps,
} from './steps';
import type { GeneratedStep, RetrievedPassage } from './types';

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Retrieve top-K passages over the WHOLE corpus (unscoped — see spec rationale). */
async function retrievePassages(query: string): Promise<RetrievedPassage[]> {
  const retrieval = await kb.send(
    new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: RERANK_COARSE_K },
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
  return passages;
}

async function converse(prompt: string): Promise<{ raw: string; usage?: Usage }> {
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

/** Generate ordered, citation-resolved steps for a task query (no title). */
export async function generateSteps(
  query: string,
): Promise<{ steps: GeneratedStep[]; usage?: Usage }> {
  const passages = await retrievePassages(query);
  const prompt = buildStepsPrompt(query, passages);
  const { raw, usage } = await converse(prompt);
  let rawSteps: ReturnType<typeof parseSteps>;
  try {
    rawSteps = parseSteps(raw);
  } catch {
    const retry = await converse(`${prompt}\n\nReturn valid JSON only, no prose.`);
    rawSteps = parseSteps(retry.raw); // throws on a second failure
  }
  return { steps: toTaskSteps(rawSteps, passages), usage };
}

/** Generate a clean title + ordered steps for a task request (for createAiTask). */
export async function generateTitledSteps(
  query: string,
): Promise<{ title: string; steps: GeneratedStep[]; usage?: Usage }> {
  const passages = await retrievePassages(query);
  const prompt = buildTitledStepsPrompt(query, passages);
  const { raw, usage } = await converse(prompt);
  let parsed: ReturnType<typeof parseTitledSteps>;
  try {
    parsed = parseTitledSteps(raw);
  } catch {
    const retry = await converse(`${prompt}\n\nReturn valid JSON only, no prose.`);
    parsed = parseTitledSteps(retry.raw); // throws on a second failure
  }
  return { title: parsed.title, steps: toTaskSteps(parsed, passages), usage };
}
