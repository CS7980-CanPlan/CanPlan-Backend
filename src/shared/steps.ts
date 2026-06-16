import type { Citation, GeneratedStep, RetrievedPassage } from './types';

/** Round-3 system prompt — copied verbatim from prototype generator.py `_SYSTEM`. */
export const SYSTEM_PROMPT =
  'You break a daily-living task into simple, ordered steps for a person with ' +
  'cognitive challenges. Use ONLY the provided sources. Each step must describe ' +
  'exactly one action, in one short sentence, using plain everyday words with no ' +
  'medical or technical jargon. Use as many steps as needed — do not merge ' +
  'actions to shorten the list. ' +
  'Preserve every essential detail from the sources: exact amounts, temperatures, ' +
  "times, and conditions (for example '74°C', 'within 2 hours', 'warm, not hot, water'). " +
  'Include every safety warning or precaution from the sources as its own step. ' +
  'Completeness and safety come before brevity. ' +
  'Respond with JSON only, no prose.';

/** Build the user prompt — verbatim shape from prototype generator.py `_build_prompt`. */
export function buildStepsPrompt(taskName: string, passages: RetrievedPassage[]): string {
  const sources = passages.map((p) => `[${p.chunkId}] ${p.text}`).join('\n');
  return (
    `Task: ${taskName}\n\n` +
    `Sources:\n${sources}\n\n` +
    'Return JSON shaped exactly as: ' +
    '{"steps": [{"text": "<one simple action, one short sentence, no jargon>", ' +
    '"citations": ["<chunk_id used>"]}]}'
  );
}

interface RawSteps {
  steps: { text: string; citations: string[] }[];
}

/** Parse + shape-validate the model output. Strips ``` fences like the prototype. */
export function parseSteps(raw: string): RawSteps {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```/, '').replace(/```$/, '').trim();
    if (text.toLowerCase().startsWith('json')) {
      text = text.slice(4).trim();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse steps from model output: ${(err as Error).message}`);
  }
  if (!isRawSteps(parsed)) {
    throw new Error('could not parse steps from model output: shape mismatch');
  }
  return parsed;
}

function isRawSteps(value: unknown): value is RawSteps {
  if (typeof value !== 'object' || value === null) return false;
  const steps = (value as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return false;
  return steps.every(
    (s) =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { text?: unknown }).text === 'string' &&
      Array.isArray((s as { citations?: unknown }).citations) &&
      (s as { citations: unknown[] }).citations.every((c) => typeof c === 'string'),
  );
}

/** Resolve a step's chunk_id citations to full Citations; drop ids not in the retrieved set. */
export function resolveCitations(chunkIds: string[], passages: RetrievedPassage[]): Citation[] {
  const byId = new Map(passages.map((p) => [p.chunkId, p]));
  const resolved: Citation[] = [];
  for (const id of chunkIds) {
    const p = byId.get(id);
    if (!p) continue;
    resolved.push({ chunkId: p.chunkId, title: p.title, url: p.url, snippet: p.text });
  }
  return resolved;
}

/** Convenience: map raw parsed steps + retrieved passages into resolved GeneratedSteps. */
export function toTaskSteps(raw: RawSteps, passages: RetrievedPassage[]): GeneratedStep[] {
  return raw.steps.map((s) => ({ text: s.text, citations: resolveCitations(s.citations, passages) }));
}
