import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// Single shared Bedrock Runtime client reused across Lambda invocations.
// Runs in the Lambda's own region; with a `global.` inference profile the
// request is then routed to whichever region has capacity.
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });

export const bedrock = client;

// Default is Claude 3 Haiku: the org SCP on this account denies newer models
// (Sonnet 4.6 and inference profiles) but allows Haiku 3 on-demand in
// ca-central-1. Override via BEDROCK_MODEL_ID once the SCP is widened — e.g.
// `global.anthropic.claude-sonnet-4-6` (a cross-region inference profile).
export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0';

// Cap on generated tokens. Kept modest so a single call stays well under
// AppSync's 30s resolver ceiling. Override per-env via the BEDROCK_MAX_TOKENS env var.
export const BEDROCK_MAX_TOKENS = Number(process.env.BEDROCK_MAX_TOKENS ?? '1024');
