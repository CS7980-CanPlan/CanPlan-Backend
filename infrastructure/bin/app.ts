#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CanPlanBackendStack } from '../lib/canplan-backend-stack';

const app = new cdk.App();

// env context is passed via --context env=dev when running cdk deploy
const envName = app.node.tryGetContext('env') ?? 'dev';

// Only the sandbox env tears down cleanly (DESTROY removal policies) so nothing
// is left billing or blocking the next deploy. dev and prod RETAIN their data.
const isSandbox = envName === 'sandbox';

new CanPlanBackendStack(app, `CanPlanBackend-${envName}`, {
  stackName: `canplan-backend-${envName}`,
  envName,
  isSandbox,
  // CDK will use your active AWS credentials/region unless overridden here.
  // Uncomment and set values to pin the account and region:
  // env: { account: '123456789012', region: 'ca-central-1' },
  tags: {
    Project: 'CanPlan',
    Environment: envName,
  },
});
