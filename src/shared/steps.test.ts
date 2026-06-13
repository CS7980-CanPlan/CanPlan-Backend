import { buildStepsPrompt, parseSteps, resolveCitations, SYSTEM_PROMPT } from './steps';
import type { RetrievedPassage } from './types';

const passages: RetrievedPassage[] = [
  { chunkId: 'hlbc-85-handwash-steps', text: 'Wet your hands, use soap for 20 seconds.', title: 'Hand washing (HealthLink BC)', url: 'https://example.com/handwash' },
  { chunkId: 'hlbc-85-handwash-tap', text: 'Use a towel to turn off the tap.', title: 'Hand washing (HealthLink BC)', url: 'https://example.com/handwash' },
];

describe('buildStepsPrompt', () => {
  it('includes the task name, a [chunk_id] sources block, and the JSON-shape instruction', () => {
    const prompt = buildStepsPrompt('wash my hands', passages);
    expect(prompt).toContain('Task: wash my hands');
    expect(prompt).toContain('[hlbc-85-handwash-steps] Wet your hands, use soap for 20 seconds.');
    expect(prompt).toContain('[hlbc-85-handwash-tap] Use a towel to turn off the tap.');
    expect(prompt).toContain('"steps"');
  });
});

describe('parseSteps', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"steps":[{"text":"Wet your hands.","citations":["hlbc-85-handwash-steps"]}]}';
    expect(parseSteps(raw)).toEqual({ steps: [{ text: 'Wet your hands.', citations: ['hlbc-85-handwash-steps'] }] });
  });

  it('strips ``` code fences before parsing', () => {
    const raw = '```json\n{"steps":[{"text":"Dry your hands.","citations":[]}]}\n```';
    expect(parseSteps(raw)).toEqual({ steps: [{ text: 'Dry your hands.', citations: [] }] });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseSteps('not json at all')).toThrow('could not parse steps');
  });

  it('throws when the shape is wrong (missing steps array)', () => {
    expect(() => parseSteps('{"foo":1}')).toThrow('could not parse steps');
  });

  it('throws when a step is missing text', () => {
    expect(() => parseSteps('{"steps":[{"citations":[]}]}')).toThrow('could not parse steps');
  });
});

describe('resolveCitations', () => {
  it('resolves a chunk_id to a full Citation from the retrieved set', () => {
    const result = resolveCitations(['hlbc-85-handwash-steps'], passages);
    expect(result).toEqual([
      { chunkId: 'hlbc-85-handwash-steps', title: 'Hand washing (HealthLink BC)', url: 'https://example.com/handwash', snippet: 'Wet your hands, use soap for 20 seconds.' },
    ]);
  });

  it('drops chunk_ids not in the retrieved set', () => {
    const result = resolveCitations(['hlbc-85-handwash-steps', 'made-up-id'], passages);
    expect(result).toHaveLength(1);
    expect(result[0].chunkId).toBe('hlbc-85-handwash-steps');
  });

  it('returns an empty array when no citations resolve', () => {
    expect(resolveCitations(['made-up-id'], passages)).toEqual([]);
  });
});

describe('SYSTEM_PROMPT', () => {
  it('is the Round-3 prompt requiring completeness and JSON-only output', () => {
    expect(SYSTEM_PROMPT).toContain('person with cognitive challenges');
    expect(SYSTEM_PROMPT).toContain('Respond with JSON only');
  });
});
