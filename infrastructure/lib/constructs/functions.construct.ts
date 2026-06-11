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
}

/** Lambda functions backing the GraphQL resolvers. */
export class Functions extends Construct {
  public readonly createTaskFn: NodejsFunction;
  public readonly askAiFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: FunctionsProps) {
    super(scope, id);

    const { envName, tasksTable, bedrockModelId } = props;

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
        BEDROCK_MODEL_ID: bedrockModelId,
        BEDROCK_MAX_TOKENS: '1024',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      // AppSync waits at most 30s for a Lambda resolver — stay just under it.
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
    });

    // Invoke any Anthropic foundation model or inference profile in this account.
    // The Lambda authenticates to Bedrock with this execution role — no API key.
    this.askAiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
          `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
        ],
      }),
    );
  }
}
