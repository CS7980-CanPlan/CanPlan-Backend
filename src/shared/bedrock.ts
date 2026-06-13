import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// Single shared Bedrock Runtime client reused across Lambda invocations.
// Bedrock runs in its OWN region (us-east-1 by default), independent of the rest
// of the backend, which stays in ca-central-1. The US Claude inference profile
// lives in us-east-1, so model calls are routed there wherever the Lambda runs.
// Deliberately NOT keyed off AWS_REGION (that's the Lambda's ca-central-1 region).
const client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? 'us-east-1' });

export const bedrock = client;

// Claude Sonnet 4.6 via the US cross-region inference profile. Configurable per
// environment through BEDROCK_MODEL_ID (set by the CDK Functions construct).
export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

// Cap on generated tokens. Kept modest so a single call stays well under
// AppSync's 30s resolver ceiling. Override per-env via the BEDROCK_MAX_TOKENS env var.
export const BEDROCK_MAX_TOKENS = Number(process.env.BEDROCK_MAX_TOKENS ?? '1024');
