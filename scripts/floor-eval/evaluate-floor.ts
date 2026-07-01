/**
 * RERANK_SCORE_FLOOR calibration harness — measures, never changes the floor.
 *
 * For each labeled query in golden-queries.json it runs the SAME two stages as production
 * (coarse KB recall → Cohere rerank) and records the TOP rerank score — the value the floor
 * is compared against. It then prints, per label, where those top scores cluster, so you can
 * place the floor in the gap between the `grounded` and `off_corpus` clusters, and shows how
 * the CURRENT floor (kb.ts) would misclassify the set.
 *
 * It deliberately does NOT call selectPassages / the threshold — it needs the raw pre-floor
 * scores. Reuses src/shared/rerank.ts so scores match runtime exactly.
 *
 * Run (against the theo stack):
 *   KNOWLEDGE_BASE_ID=0O7BHJDCZR BEDROCK_REGION=us-east-1 \
 *   AWS_PROFILE=909155337335_myisb_IsbUsersPS \
 *   npx ts-node scripts/floor-eval/evaluate-floor.ts [--csv out.csv]
 */
import { writeFileSync } from 'fs';
import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { kb, KNOWLEDGE_BASE_ID, RERANK_COARSE_K, RERANK_SCORE_FLOOR } from '../../src/shared/kb';
import { rerankPassages } from '../../src/shared/rerank';
import type { RetrievedPassage } from '../../src/shared/types';
import golden from './golden-queries.json';

type Label = 'grounded' | 'off_corpus';
interface GoldenQuery {
  query: string;
  label: Label;
  note?: string;
}
interface Row extends GoldenQuery {
  top: number | null; // top rerank score; null when coarse recall returned nothing
  n: number; // coarse candidate count
}

/** Stage 1 only — coarse vector recall, mirroring stepsService.retrievePassages (pre-rerank). */
async function coarseRetrieve(query: string): Promise<RetrievedPassage[]> {
  const r = await kb.send(
    new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: RERANK_COARSE_K } },
    }),
  );
  return (r.retrievalResults ?? []).map((x) => ({
    chunkId: String(x.metadata?.chunk_id ?? ''),
    text: x.content?.text ?? '',
    title: String(x.metadata?.title ?? ''),
    url: x.metadata?.url ? String(x.metadata.url) : undefined,
  }));
}

async function topScoreFor(query: string): Promise<{ top: number | null; n: number }> {
  const candidates = await coarseRetrieve(query);
  if (candidates.length === 0) return { top: null, n: 0 };
  const scored = await rerankPassages(query, candidates);
  const top = scored.reduce((m, s) => Math.max(m, s.score), -Infinity);
  return { top: Number.isFinite(top) ? top : null, n: candidates.length };
}

const fmt = (x: number | null) => (x === null ? ' null' : x.toFixed(3));
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  if (!KNOWLEDGE_BASE_ID) {
    console.error(
      'KNOWLEDGE_BASE_ID is empty. Set it (e.g. KNOWLEDGE_BASE_ID=0O7BHJDCZR for the theo stack) ' +
        'plus BEDROCK_REGION and AWS_PROFILE, then re-run.',
    );
    process.exit(1);
  }

  const all = golden.queries as GoldenQuery[];
  const queries = all.filter((q) => q.query && !q.query.startsWith('<'));
  console.log(
    `Floor eval — KB ${KNOWLEDGE_BASE_ID}, coarseK ${RERANK_COARSE_K}, current floor ${RERANK_SCORE_FLOOR}\n` +
      `${queries.length} queries (${all.length - queries.length} placeholders skipped)\n`,
  );

  const rows: Row[] = [];
  console.log('top    label       n    query');
  for (const q of queries) {
    const { top, n } = await topScoreFor(q.query);
    rows.push({ ...q, top, n });
    console.log(`${fmt(top)}  ${q.label.padEnd(10)} ${String(n).padStart(3)}   ${q.query}`);
  }

  // ── Cluster summary ──────────────────────────────────────────────────────────
  const g = rows.filter((r) => r.label === 'grounded');
  const o = rows.filter((r) => r.label === 'off_corpus');
  const tops = (rs: Row[]) => rs.map((r) => (r.top === null ? -1 : r.top));
  const gTops = tops(g);
  const oTops = tops(o);
  const gMin = g.length ? Math.min(...gTops) : null;
  const oMax = o.length ? Math.max(...oTops) : null;

  console.log('\n── clusters (top rerank score by label) ──');
  console.log(
    `grounded   (n=${g.length})  min ${fmt(gMin)}  median ${fmt(median(gTops))}  max ${fmt(g.length ? Math.max(...gTops) : null)}`,
  );
  console.log(
    `off_corpus (n=${o.length})  min ${fmt(o.length ? Math.min(...oTops) : null)}  median ${fmt(median(oTops))}  max ${fmt(oMax)}`,
  );

  if (gMin !== null && oMax !== null) {
    if (gMin > oMax) {
      const suggested = Math.round(((gMin + oMax) / 2) * 100) / 100;
      console.log(
        `\nCleanly separable: gap (${fmt(oMax)}, ${fmt(gMin)}). Suggested floor ≈ ${suggested} ` +
          `(midpoint). Any value in the gap classifies this set perfectly.`,
      );
    } else {
      console.log(
        `\nClusters OVERLAP in [${fmt(gMin)}, ${fmt(oMax)}] — no floor classifies the set perfectly. ` +
          `Pick by tolerance: lower floor = fewer false rejects but more false accepts.`,
      );
    }
  }

  // ── How the CURRENT floor would do ───────────────────────────────────────────
  const falseRejects = g.filter((r) => (r.top === null ? true : r.top < RERANK_SCORE_FLOOR));
  const falseAccepts = o.filter((r) => r.top !== null && r.top >= RERANK_SCORE_FLOOR);
  console.log(`\n── current floor ${RERANK_SCORE_FLOOR} on this set ──`);
  console.log(`false rejects (grounded below floor):  ${falseRejects.length}/${g.length}`);
  falseRejects.forEach((r) => console.log(`   ${fmt(r.top)}  ${r.query}`));
  console.log(`false accepts (off_corpus at/above floor): ${falseAccepts.length}/${o.length}`);
  falseAccepts.forEach((r) => console.log(`   ${fmt(r.top)}  ${r.query}`));

  // ── Optional CSV ─────────────────────────────────────────────────────────────
  const csvFlag = process.argv.indexOf('--csv');
  if (csvFlag !== -1 && process.argv[csvFlag + 1]) {
    const path = process.argv[csvFlag + 1];
    const csv = ['query,label,top_score,coarse_n']
      .concat(rows.map((r) => `${JSON.stringify(r.query)},${r.label},${r.top ?? ''},${r.n}`))
      .join('\n');
    writeFileSync(path, csv + '\n');
    console.log(`\nwrote ${path}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
