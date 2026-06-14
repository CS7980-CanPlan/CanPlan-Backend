#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CanPlanBackendStack } from '../lib/canplan-backend-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

const app = new cdk.App();

// env context is passed via --context env=dev when running cdk deploy
const envName = app.node.tryGetContext('env') ?? 'dev';

// Only the sandbox env tears down cleanly (DESTROY removal policies) so nothing
// is left billing or blocking the next deploy. dev and prod RETAIN their data.
const isSandbox = envName === 'sandbox';

// Same account for both stacks; the KB region is resolved once and shared with
// the backend Lambda config so the Retrieve target cannot drift.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const backendRegion =
  app.node.tryGetContext('backendRegion') ??
  process.env.CANPLAN_BACKEND_REGION ??
  'ca-central-1';
const knowledgeBaseRegion =
  app.node.tryGetContext('knowledgeBaseRegion') ??
  app.node.tryGetContext('bedrockRegion') ??
  process.env.CANPLAN_KNOWLEDGE_BASE_REGION ??
  process.env.BEDROCK_REGION ??
  'us-east-1';
const tags = {
  Project: 'CanPlan',
  Environment: envName,
};

// Knowledge Base must live in the Bedrock region (embedding-model availability +
// the org SCP). Keep this region in sync with the backend Lambda's Bedrock client.
const knowledgeBaseStack = new KnowledgeBaseStack(app, `CanPlanKnowledgeBase-${envName}`, {
  stackName: `canplan-knowledge-base-${envName}`,
  envName,
  isSandbox,
  env: { account, region: knowledgeBaseRegion },
  crossRegionReferences: true,
  tags,
});

// Backend (DynamoDB/AppSync/Cognito/Lambdas) stays in ca-central-1 and takes the
// KB id from the Bedrock-region stack via a cross-region reference.
new CanPlanBackendStack(app, `CanPlanBackend-${envName}`, {
  stackName: `canplan-backend-${envName}`,
  envName,
  isSandbox,
  knowledgeBaseId: knowledgeBaseStack.knowledgeBaseId,
  bedrockRegion: knowledgeBaseRegion,
  env: { account, region: backendRegion },
  crossRegionReferences: true,
  tags,
});
