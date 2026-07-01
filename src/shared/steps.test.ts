import { buildStepsPrompt, parseSteps, resolveCitations, SYSTEM_PROMPT, buildTitledStepsPrompt, buildUngroundedTitledStepsPrompt, stepCountInstruction, parseTitledSteps } from './steps';
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

describe('buildTitledStepsPrompt', () => {
  it('includes the request, the sources block, and a title+steps JSON shape', () => {
    const prompt = buildTitledStepsPrompt('wash my hands', passages);
    expect(prompt).toContain('Task: wash my hands');
    expect(prompt).toContain('[hlbc-85-handwash-steps] Wet your hands, use soap for 20 seconds.');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"steps"');
  });

  it('asks for no more than 20 steps when no stepCount is given', () => {
    expect(buildTitledStepsPrompt('wash my hands', passages)).toContain('no more than 20 steps');
  });

  it('asks for exactly N steps when stepCount is given', () => {
    expect(buildTitledStepsPrompt('wash my hands', passages, 3)).toContain('Return exactly 3 steps.');
  });
});

describe('stepCountInstruction', () => {
  it('caps at 20 when omitted', () => {
    expect(stepCountInstruction()).toBe('Return no more than 20 steps.');
  });

  it('requests an exact count, pluralizing correctly', () => {
    expect(stepCountInstruction(1)).toBe('Return exactly 1 step.');
    expect(stepCountInstruction(5)).toBe('Return exactly 5 steps.');
  });
});

describe('buildUngroundedTitledStepsPrompt', () => {
  it('has no Sources block and carries the step-count instruction', () => {
    const prompt = buildUngroundedTitledStepsPrompt('scramble eggs', 4);
    expect(prompt).toContain('Task: scramble eggs');
    expect(prompt).not.toContain('Sources:');
    expect(prompt).toContain('Return exactly 4 steps.');
  });
});

describe('parseTitledSteps', () => {
  it('parses a clean { title, steps } object', () => {
    const raw = '{"title":"Wash your hands","steps":[{"text":"Wet your hands.","citations":["hlbc-85-handwash-steps"]}]}';
    expect(parseTitledSteps(raw)).toEqual({
      title: 'Wash your hands',
      steps: [{ text: 'Wet your hands.', citations: ['hlbc-85-handwash-steps'] }],
    });
  });

  it('strips ``` code fences before parsing', () => {
    const raw = '```json\n{"title":"Dry hands","steps":[{"text":"Dry your hands.","citations":[]}]}\n```';
    expect(parseTitledSteps(raw)).toEqual({
      title: 'Dry hands',
      steps: [{ text: 'Dry your hands.', citations: [] }],
    });
  });

  it('throws when title is missing or empty', () => {
    expect(() => parseTitledSteps('{"steps":[{"text":"x","citations":[]}]}')).toThrow('could not parse titled steps');
    expect(() => parseTitledSteps('{"title":"   ","steps":[{"text":"x","citations":[]}]}')).toThrow('could not parse titled steps');
  });

  it('throws when steps shape is wrong', () => {
    expect(() => parseTitledSteps('{"title":"t","steps":[{"citations":[]}]}')).toThrow('could not parse titled steps');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseTitledSteps('not json')).toThrow('could not parse titled steps');
  });
});
