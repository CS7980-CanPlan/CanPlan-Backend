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

// Same account for both stacks; region is pinned per-stack below.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const tags = {
  Project: 'CanPlan',
  Environment: envName,
};

// Knowledge Base must live in us-east-1 (embedding-model availability + the only
// region validated against the org SCP). Pinned here, separate from the backend.
const knowledgeBaseStack = new KnowledgeBaseStack(app, `CanPlanKnowledgeBase-${envName}`, {
  stackName: `canplan-knowledge-base-${envName}`,
  envName,
  isSandbox,
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  tags,
});

// Backend (DynamoDB/AppSync/Cognito/Lambdas) stays in ca-central-1 and takes the
// KB id from the us-east-1 stack via a cross-region reference.
new CanPlanBackendStack(app, `CanPlanBackend-${envName}`, {
  stackName: `canplan-backend-${envName}`,
  envName,
  isSandbox,
  knowledgeBaseId: knowledgeBaseStack.knowledgeBaseId,
  env: { account, region: 'ca-central-1' },
  crossRegionReferences: true,
  tags,
});
