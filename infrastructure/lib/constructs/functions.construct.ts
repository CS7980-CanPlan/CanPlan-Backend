import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface FunctionsProps {
  readonly envName: string;
  /** Tasks table the createTask Lambda writes to. */
  readonly tasksTable: dynamodb.ITable;
  /** Bedrock model id passed to the askAi Lambda. */
  readonly bedrockModelId: string;
  /** Region the askAi Lambda calls Bedrock Runtime in (e.g. us-east-1). */
  readonly bedrockRegion: string;
}

/** Lambda functions backing the GraphQL resolvers. */
export class Functions extends Construct {
  public readonly createTaskFn: NodejsFunction;
  public readonly askAiFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: FunctionsProps) {
    super(scope, id);

    const { envName, tasksTable, bedrockModelId, bedrockRegion } = props;

    // ── createTask ────────────────────────────────────────────────────────────
    this.createTaskFn = new NodejsFunction(this, 'CreateTaskFunction', {
      functionName: `canplan-createTask-${envName}`,
      entry: path.join(__dirname, '../../../src/lambdas/createTask/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        DYNAMODB_TABLE_NAME: tasksTable.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.seconds(10),
    });

    // Least-privilege: write-only access to the tasks table.
    tasksTable.grantWriteData(this.createTaskFn);

    // ── askAi (Amazon Bedrock) ──────────────────────────────────────────────────
    this.askAiFn = new NodejsFunction(this, 'AskAiFunction', {
      functionName: `canplan-askAi-${envName}`,
      entry: path.join(__dirname, '../../../src/lambdas/askAi/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        // Bedrock runs in its own region (us-east-1) — the rest of the backend
        // stays in ca-central-1. The Bedrock client keys off BEDROCK_REGION, not
        // the Lambda's AWS_REGION, so inference is routed to the US profile.
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_MODEL_ID: bedrockModelId,
        BEDROCK_MAX_TOKENS: '1024',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      // AppSync waits at most 30s for a Lambda resolver — stay just under it.
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
    });

    // Invoke Claude via Bedrock (Converse + raw Invoke, sync + streaming). The
    // Lambda authenticates to Bedrock with this execution role — no API key.
    // A cross-region inference profile needs permission on BOTH the profile and
    // the underlying foundation models in every region it can route to, so the
    // resources span all regions (`*`) for Anthropic models + account profiles.
    this.askAiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: [
          `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
        ],
      }),
    );
  }
}
