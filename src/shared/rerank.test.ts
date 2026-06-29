import { selectPassages, type ScoredPassage, type ThresholdConfig } from './rerank';

const cfg: ThresholdConfig = { floor: 0.3, ratio: 0.5, min: 2, max: 5 };

function p(chunkId: string, score: number): ScoredPassage {
  return { chunkId, text: `text-${chunkId}`, title: `title-${chunkId}`, url: undefined, score };
}

describe('selectPassages', () => {
  it('returns empty for an empty input', () => {
    expect(selectPassages([], cfg)).toEqual([]);
  });

  it('returns empty when even the top score is below the absolute floor', () => {
    expect(selectPassages([p('a', 0.2), p('b', 0.1)], cfg)).toEqual([]);
  });

  it('keeps passages at or above max(floor, top*ratio)', () => {
    // top=0.9 -> effective=max(0.3, 0.45)=0.45; keep 0.9 and 0.5, drop 0.4
    const out = selectPassages([p('a', 0.9), p('b', 0.5), p('c', 0.4)], cfg);
    expect(out.map((x) => x.chunkId)).toEqual(['a', 'b']);
  });

  it('drops the rerank score from the returned passages', () => {
    const out = selectPassages([p('a', 0.9), p('b', 0.6)], cfg);
    expect(out[0]).toEqual({ chunkId: 'a', text: 'text-a', title: 'title-a', url: undefined });
    expect((out[0] as unknown as Record<string, unknown>).score).toBeUndefined();
  });

  it('back-fills up to min using floor-passing passages when the ratio is too strict', () => {
    // top=0.9 -> effective=0.45 keeps only 'a'; min=2 back-fills 'b' (0.35 >= floor 0.3)
    const out = selectPassages([p('a', 0.9), p('b', 0.35), p('c', 0.2)], cfg);
    expect(out.map((x) => x.chunkId)).toEqual(['a', 'b']);
  });

  it('never lowers the floor to satisfy min (returns fewer than min)', () => {
    // only 'a' clears floor 0.3; min=2 cannot be met -> return just 'a'
    const out = selectPassages([p('a', 0.8), p('b', 0.25), p('c', 0.1)], cfg);
    expect(out.map((x) => x.chunkId)).toEqual(['a']);
  });

  it('truncates to max', () => {
    const flat = [p('a', 0.9), p('b', 0.89), p('c', 0.88), p('d', 0.87), p('e', 0.86), p('f', 0.85)];
    expect(selectPassages(flat, { floor: 0.3, ratio: 0.5, min: 2, max: 5 })).toHaveLength(5);
  });

  it('sorts by score descending before selecting', () => {
    const out = selectPassages([p('low', 0.6), p('high', 0.95)], cfg);
    expect(out[0].chunkId).toBe('high');
  });
});
