# Floor calibration harness

Measures where `RERANK_SCORE_FLOOR` (`src/shared/kb.ts`) *should* sit. It does **not**
change the floor — it only reports scores so you can choose one.

## When to run

After the corpus is near its final size. A floor tuned on a partial corpus won't hold:
adding passages shifts the rerank score distribution and invalidates the chosen value.
Until then the default `0.3` is fine (the no-guidance path fails safe).

## What it does

For each labeled query in `golden-queries.json` it runs the same two stages as production —
coarse KB recall (`RERANK_COARSE_K`) then Cohere rerank (`rerankPassages`) — and records the
**top rerank score**. It then prints, per label, where those scores cluster and how the
current floor would misclassify the set:

- **false reject (误杀)** — a `grounded` query whose top score is below the floor (had usable
  guidance, got rejected).
- **false accept (漏网)** — an `off_corpus` query whose top score clears the floor (irrelevant
  passage treated as grounded).

The floor should land in the gap between the two clusters.

## 1. Build the golden set

Edit `golden-queries.json`. Label each query by what the corpus is **meant** to do:
`grounded` (corpus covers it) or `off_corpus` (it doesn't). Aim for ~15+ of each, and make
sure to include **borderline** daily-living tasks — that's where the floor actually matters.
Placeholders (queries starting with `<`) are skipped.

## 2. Run

```sh
KNOWLEDGE_BASE_ID=0O7BHJDCZR BEDROCK_REGION=us-east-1 \
AWS_PROFILE=909155337335_myisb_IsbUsersPS \
npx ts-node scripts/floor-eval/evaluate-floor.ts
```

`0O7BHJDCZR` is the theo-stack KB id; swap it for whichever stack's corpus you're calibrating.
Add `--csv out.csv` to also dump per-query scores for plotting.

## 3. Pick the floor

- **Cleanly separable** → use the suggested midpoint.
- **Overlapping clusters** → trade off: lower floor = fewer false rejects but more false
  accepts. For this caregiving app, bias toward fewer false accepts (don't pass weak matches
  off as grounded).

Then set `RERANK_SCORE_FLOOR` (env override or the `kb.ts` default) to the chosen value.
