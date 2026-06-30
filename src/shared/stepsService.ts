import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  kb,
  KNOWLEDGE_BASE_ID,
  RERANK_COARSE_K,
  RERANK_SCORE_FLOOR,
  RERANK_REL_RATIO,
  RERANK_MIN_RESULTS,
  RERANK_MAX_RESULTS,
} from './kb';
import { rerankPassages, selectPassages } from './rerank';
import { bedrock, BEDROCK_MODEL_ID, BEDROCK_MAX_TOKENS } from './bedrock';
import { NotFoundError } from './response';
import {
  SYSTEM_PROMPT,
  UNGROUNDED_SYSTEM_PROMPT,
  buildStepsPrompt,
  buildTitledStepsPrompt,
  buildUngroundedTitledStepsPrompt,
  parseSteps,
  parseTitledSteps,
  parseUngroundedTitledSteps,
  toTaskSteps,
} from './steps';
import type { GeneratedStep, RetrievedPassage } from './types';

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Two-stage retrieval: coarse vector recall over the whole corpus, then a Cohere
 * rerank, then a dynamic relevance threshold. Returns an EMPTY array when nothing
 * clears the floor — the caller decides whether to fail or fall back to ungrounded
 * generation (see generateTitledSteps).
 */
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
  const candidates: RetrievedPassage[] = (retrieval.retrievalResults ?? []).map((r) => ({
    chunkId: String(r.metadata?.chunk_id ?? ''),
    text: r.content?.text ?? '',
    title: String(r.metadata?.title ?? ''),
    url: r.metadata?.url ? String(r.metadata.url) : undefined,
  }));
  if (candidates.length === 0) {
    return [];
  }

  const scored = await rerankPassages(query, candidates);
  return selectPassages(scored, {
    floor: RERANK_SCORE_FLOOR,
    ratio: RERANK_REL_RATIO,
    min: RERANK_MIN_RESULTS,
    max: RERANK_MAX_RESULTS,
  });
}

async function converse(
  prompt: string,
  system: string = SYSTEM_PROMPT,
): Promise<{ raw: string; usage?: Usage }> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: system }],
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
  if (passages.length === 0) {
    throw new NotFoundError('no relevant guidance found for this task');
  }
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

/**
 * Fallback when no corpus passage clears the threshold: generate a title + steps from
 * the model's general knowledge (no sources, no citations), flagged `grounded: false`.
 * Only ever reached for callers allowed to fall back (see generateTitledSteps).
 */
async function generateUngroundedTitledSteps(
  query: string,
): Promise<{ title: string; steps: GeneratedStep[]; grounded: false; usage?: Usage }> {
  const prompt = buildUngroundedTitledStepsPrompt(query);
  const { raw, usage } = await converse(prompt, UNGROUNDED_SYSTEM_PROMPT);
  let parsed: ReturnType<typeof parseUngroundedTitledSteps>;
  try {
    parsed = parseUngroundedTitledSteps(raw);
  } catch {
    const retry = await converse(
      `${prompt}\n\nReturn valid JSON only, no prose.`,
      UNGROUNDED_SYSTEM_PROMPT,
    );
    parsed = parseUngroundedTitledSteps(retry.raw); // throws on a second failure
  }
  return {
    title: parsed.title,
    steps: parsed.steps.map((s) => ({ text: s.text, citations: [] })),
    grounded: false,
    usage,
  };
}

/**
 * Generate a clean title + ordered steps for a task request (for createAiTask).
 *
 * When no corpus passage clears the relevance threshold:
 *  - `allowFallback` true  → fall back to ungrounded generation (`grounded: false`).
 *  - `allowFallback` false → throw NotFoundError; nothing ungrounded is ever returned.
 * The caller gates `allowFallback` on the authenticated role (only support persons).
 */
export async function generateTitledSteps(
  query: string,
  opts: { allowFallback?: boolean } = {},
): Promise<{ title: string; steps: GeneratedStep[]; grounded: boolean; usage?: Usage }> {
  const passages = await retrievePassages(query);
  if (passages.length === 0) {
    if (!opts.allowFallback) {
      throw new NotFoundError('no relevant guidance found for this task');
    }
    return generateUngroundedTitledSteps(query);
  }
  const prompt = buildTitledStepsPrompt(query, passages);
  const { raw, usage } = await converse(prompt);
  let parsed: ReturnType<typeof parseTitledSteps>;
  try {
    parsed = parseTitledSteps(raw);
  } catch {
    const retry = await converse(`${prompt}\n\nReturn valid JSON only, no prose.`);
    parsed = parseTitledSteps(retry.raw); // throws on a second failure
  }
  return { title: parsed.title, steps: toTaskSteps(parsed, passages), grounded: true, usage };
}
