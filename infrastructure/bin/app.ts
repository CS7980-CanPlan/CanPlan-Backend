#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CanPlanBackendStack } from '../lib/canplan-backend-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

const app = new cdk.App();

const KNOWN_ENV_NAMES = new Set(['dev', 'prod', 'sandbox']);
const PERSONAL_OWNER_PATTERN = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

function contextString(name: string): string | undefined {
  const value = app.node.tryGetContext(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function contextFlag(name: string): boolean {
  const value = app.node.tryGetContext(name);
  return value === true || value === 'true' || value === '1';
}

function normalizeName(value: string, contextName: string): string {
  const normalized = value.toLowerCase();
  if (!PERSONAL_OWNER_PATTERN.test(normalized)) {
    throw new Error(
      `${contextName} must be 1-20 lowercase letters, numbers, or hyphens, start with a letter, and end with a letter or number.`,
    );
  }
  return normalized;
}

// env context is passed via --context env=dev when running cdk deploy.
const envName = normalizeName(contextString('env') ?? 'dev', 'env');
const isPersonal = contextFlag('personal');
const ownerContext = contextString('owner');
const ownerName = ownerContext ? normalizeName(ownerContext, 'owner') : undefined;

if (!KNOWN_ENV_NAMES.has(envName) && !isPersonal) {
  throw new Error(
    `Unknown environment "${envName}". For a personal environment, use npm run cdk:deploy:me or pass --context personal=true --context owner=${envName}.`,
  );
}

if (isPersonal) {
  if (!ownerName) {
    throw new Error('Personal deployments require --context owner=<name>.');
  }
  if (KNOWN_ENV_NAMES.has(ownerName)) {
    throw new Error(`Personal owner "${ownerName}" conflicts with a shared environment name.`);
  }
  if (ownerName !== envName) {
    throw new Error(`Personal deployments require env (${envName}) to match owner (${ownerName}).`);
  }
} else if (ownerName) {
  throw new Error('--context owner=... is only valid with --context personal=true.');
}

// Sandbox and personal environments tear down cleanly. dev and prod retain data.
const isDestroyable = envName === 'sandbox' || isPersonal;

// Same account for both stacks; the KB region is resolved once and shared with
// the backend Lambda config so the Retrieve target cannot drift.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const backendRegion =
  app.node.tryGetContext('backendRegion') ?? process.env.CANPLAN_BACKEND_REGION ?? 'ca-central-1';
const knowledgeBaseRegion =
  app.node.tryGetContext('knowledgeBaseRegion') ??
  app.node.tryGetContext('bedrockRegion') ??
  process.env.CANPLAN_KNOWLEDGE_BASE_REGION ??
  process.env.BEDROCK_REGION ??
  'us-east-1';
// Backend-only HMAC secret that signs AI report draft tokens (generateReport → saveReport).
// Shared envs (dev/prod) MUST supply a strong random value; personal/sandbox deploys fall back
// to an env-scoped, clearly dev-only default so local deploys work without extra setup.
// TODO: promote to AWS Secrets Manager if reports graduate past MVP (this bakes the value into
// the Lambda's environment / CloudFormation template).
const reportDraftSigningSecretInput =
  contextString('reportDraftSigningSecret') ?? process.env.REPORT_DRAFT_SIGNING_SECRET;
if (!reportDraftSigningSecretInput && !isDestroyable) {
  throw new Error(
    'REPORT_DRAFT_SIGNING_SECRET must be set for dev/prod deployments — a strong random value ' +
      'that signs AI report draft tokens. Set the env var or pass ' +
      '--context reportDraftSigningSecret=...',
  );
}
const reportDraftSigningSecret =
  reportDraftSigningSecretInput ?? `canplan-report-draft-dev-only-${envName}`;

const tags = {
  Project: 'CanPlan',
  Environment: envName,
  EnvironmentType: isPersonal ? 'personal' : envName === 'sandbox' ? 'sandbox' : 'shared',
  ...(ownerName ? { Owner: ownerName } : {}),
};

// Knowledge Base must live in the Bedrock region (embedding-model availability +
// the org SCP). Keep this region in sync with the backend Lambda's Bedrock client.
const knowledgeBaseStack = new KnowledgeBaseStack(app, `CanPlanKnowledgeBase-${envName}`, {
  stackName: `canplan-knowledge-base-${envName}`,
  envName,
  isDestroyable,
  env: { account, region: knowledgeBaseRegion },
  crossRegionReferences: true,
  tags,
});

// Backend (DynamoDB/AppSync/Cognito/Lambdas) stays in ca-central-1 and takes the
// KB id from the Bedrock-region stack via a cross-region reference.
new CanPlanBackendStack(app, `CanPlanBackend-${envName}`, {
  stackName: `canplan-backend-${envName}`,
  envName,
  isDestroyable,
  knowledgeBaseId: knowledgeBaseStack.knowledgeBaseId,
  bedrockRegion: knowledgeBaseRegion,
  reportDraftSigningSecret,
  env: { account, region: backendRegion },
  crossRegionReferences: true,
  tags,
});
