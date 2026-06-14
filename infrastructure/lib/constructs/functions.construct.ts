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
  /** Bedrock model id passed to the generateTaskSteps Lambda. */
  readonly bedrockModelId: string;
  /** Region the generateTaskSteps Lambda calls Bedrock in (e.g. us-east-1). */
  readonly bedrockRegion: string;
  /** Knowledge Base id the generateTaskSteps Lambda retrieves from. */
  readonly knowledgeBaseId: string;
}

/** Lambda functions backing the GraphQL resolvers. */
export class Functions extends Construct {
  public readonly createTaskFn: NodejsFunction;
  public readonly generateTaskStepsFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: FunctionsProps) {
    super(scope, id);

    const { envName, tasksTable, bedrockModelId, bedrockRegion, knowledgeBaseId } = props;

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

    // ── generateTaskSteps (Bedrock KB + RAG) ────────────────────────────────────
    this.generateTaskStepsFn = new NodejsFunction(this, 'GenerateTaskStepsFunction', {
      functionName: `canplan-generateTaskSteps-${envName}`,
      entry: path.join(__dirname, '../../../src/lambdas/generateTaskSteps/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_MODEL_ID: bedrockModelId,
        BEDROCK_MAX_TOKENS: '1024',
        KNOWLEDGE_BASE_ID: knowledgeBaseId,
        RETRIEVAL_TOP_K: '4',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
    });

    // Converse (Sonnet) after KB retrieval. A cross-region inference profile
    // needs permission on BOTH the profile and the underlying foundation models.
    this.generateTaskStepsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
        resources: [
          `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
        ],
      }),
    );
    // KB Retrieve — scoped to the one Knowledge Base, in us-east-1.
    this.generateTaskStepsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [`arn:aws:bedrock:${bedrockRegion}:${cdk.Stack.of(this).account}:knowledge-base/${knowledgeBaseId}`],
      }),
    );
  }
}
