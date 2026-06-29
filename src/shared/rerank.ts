import type { RetrievedPassage } from './types';

/** A retrieved passage carrying its stage-2 rerank relevance score (internal). */
export interface ScoredPassage extends RetrievedPassage {
  score: number;
}

/** Dynamic-threshold knobs (sourced from kb.ts constants at call time). */
export interface ThresholdConfig {
  floor: number; // absolute relevance floor τ
  ratio: number; // relative cutoff = topScore × ratio
  min: number; // min kept, only among floor-passing passages
  max: number; // hard cap on kept count
}

/**
 * Apply the hybrid dynamic threshold to reranked passages.
 *
 * Keep passages with score ≥ max(floor, topScore × ratio), bounded by [min, max].
 * `min` may relax the relative ratio but NEVER the absolute floor: if fewer than
 * `min` passages clear the floor, return however many do (possibly zero).
 */
export function selectPassages(
  scored: ScoredPassage[],
  cfg: ThresholdConfig,
): RetrievedPassage[] {
  if (scored.length === 0) return [];
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted[0].score;
  const effective = Math.max(cfg.floor, top * cfg.ratio);

  let kept = sorted.filter((x) => x.score >= effective);
  if (kept.length < cfg.min) {
    // Back-fill toward `min`, but only with passages that clear the absolute floor.
    kept = sorted.filter((x) => x.score >= cfg.floor).slice(0, cfg.min);
  }
  kept = kept.slice(0, cfg.max);

  return kept.map((x) => ({ chunkId: x.chunkId, text: x.text, title: x.title, url: x.url }));
}
