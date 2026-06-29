import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';

// Bedrock Knowledge Base lives in the configured Bedrock region, co-located with
// the Sonnet inference profile and titan embedding model. Keyed off
// BEDROCK_REGION (NOT AWS_REGION, which is the Lambda's ca-central-1), exactly
// like the Bedrock Runtime client.
const client = new BedrockAgentRuntimeClient({ region: process.env.BEDROCK_REGION ?? 'us-east-1' });

export const kb = client;

// The Knowledge Base id, injected by the CDK Functions construct after the KB is built.
export const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

// ── Two-stage retrieval config (all env-overridable; defaults are golden-set
//    starting points). Stage 1 = coarse vector recall; stage 2 = Cohere rerank. ──

/** Stage-1 candidate count handed to the reranker (corpus ~160; ~15%). */
export const RERANK_COARSE_K = Number(process.env.RERANK_COARSE_K ?? '25');

/** Cohere Rerank 3.5 — the only reranker available in us-east-1. */
export const RERANK_MODEL_ID = process.env.RERANK_MODEL_ID ?? 'cohere.rerank-v3-5:0';

/** Foundation-model ARN for the reranker, in the Bedrock region. */
export const RERANK_MODEL_ARN = `arn:aws:bedrock:${process.env.BEDROCK_REGION ?? 'us-east-1'}::foundation-model/${RERANK_MODEL_ID}`;

/** Absolute relevance floor (0–1); rejects globally low-quality matches. */
export const RERANK_SCORE_FLOOR = Number(process.env.RERANK_SCORE_FLOOR ?? '0.3');

/** Relative cutoff = topScore × ratio; adapts to query difficulty. */
export const RERANK_REL_RATIO = Number(process.env.RERANK_REL_RATIO ?? '0.5');

/** Min kept (only ever among floor-passing passages). */
export const RERANK_MIN_RESULTS = Number(process.env.RERANK_MIN_RESULTS ?? '2');

/** Max kept; caps prompt length. */
export const RERANK_MAX_RESULTS = Number(process.env.RERANK_MAX_RESULTS ?? '5');
