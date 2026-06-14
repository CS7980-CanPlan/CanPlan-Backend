import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';

// Bedrock Knowledge Base lives in the configured Bedrock region, co-located with
// the Sonnet inference profile and titan embedding model. Keyed off
// BEDROCK_REGION (NOT AWS_REGION, which is the Lambda's ca-central-1), exactly
// like the Bedrock Runtime client.
const client = new BedrockAgentRuntimeClient({ region: process.env.BEDROCK_REGION ?? 'us-east-1' });

export const kb = client;

// The Knowledge Base id, injected by the CDK Functions construct after the KB is built.
export const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

// Frozen Round-3 retrieval setting. Higher K worsens off-task bleed (see spec
// rationale); re-tune against the 28-task golden set once the KB is live.
export const RETRIEVAL_TOP_K = Number(process.env.RETRIEVAL_TOP_K ?? '4');
