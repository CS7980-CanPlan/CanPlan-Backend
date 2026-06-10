import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CanPlanBackendStackProps extends cdk.StackProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod') — used to namespace resources. */
  readonly envName: string;
  /**
   * When true, all resources tear down cleanly with `cdk destroy` — no retained
   * tables or buckets left behind to incur cost or block the next deploy on a
   * name collision. Set for sandbox only; leave false (RETAIN) for dev / prod.
   */
  readonly isSandbox: boolean;
}

export class CanPlanBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CanPlanBackendStackProps) {
    super(scope, id, props);

    const { envName, isSandbox } = props;
    // In a sandbox we want a clean teardown; everywhere else we protect data.
    const dataRemovalPolicy = isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // ── DynamoDB ──────────────────────────────────────────────────────────────
    const tasksTable = new dynamodb.Table(this, 'CanPlanTasksTable', {
      tableName: `CanPlanTasks-${envName}`,
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Sandbox: destroy with the stack. dev / prod: retain to prevent data loss.
      removalPolicy: dataRemovalPolicy,
    });

    // ── S3 (future media storage) ─────────────────────────────────────────────
    // envName keeps the bucket unique per environment within the same account.
    new s3.Bucket(this, 'CanPlanMediaBucket', {
      bucketName: `canplan-media-${envName}-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Sandbox: empty + delete on teardown. dev / prod: retain.
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: isSandbox,
    });

    // ── Lambda — createTask ───────────────────────────────────────────────────
    const createTaskFn = new NodejsFunction(this, 'CreateTaskFunction', {
      functionName: `canplan-createTask-${envName}`,
      entry: path.join(__dirname, '../../src/lambdas/createTask/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        DYNAMODB_TABLE_NAME: tasksTable.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.seconds(10),
      // Reserve concurrency of 0 can be set here later to throttle if needed
    });

    // Least-privilege: Lambda can only put items — not read or delete
    tasksTable.grantWriteData(createTaskFn);

    // ── Lambda — askAi (Amazon Bedrock) ───────────────────────────────────────
    // Default is Claude 3 Haiku. The org SCP (p-nnv8kbbh) on this account denies
    // bedrock:InvokeModel for newer models (Sonnet 4.6 / inference profiles) but
    // allows Haiku 3 on-demand in ca-central-1. Override once the SCP is widened:
    //   --context bedrockModelId=global.anthropic.claude-sonnet-4-6
    // (or set the BEDROCK_MODEL_ID env var on the function).
    const bedrockModelId =
      this.node.tryGetContext('bedrockModelId') ?? 'anthropic.claude-3-haiku-20240307-v1:0';

    const askAiFn = new NodejsFunction(this, 'AskAiFunction', {
      functionName: `canplan-askAi-${envName}`,
      entry: path.join(__dirname, '../../src/lambdas/askAi/handler.ts'),
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
    // Broad enough that changing BEDROCK_MODEL_ID needs no IAM change; the org
    // SCP is the real guardrail on which models are actually allowed. The Lambda
    // authenticates to Bedrock with this execution role — no API key needed.
    askAiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // ── AppSync GraphQL API ───────────────────────────────────────────────────
    const api = new appsync.GraphqlApi(this, 'CanPlanApi', {
      name: `canplan-api-${envName}`,
      schema: appsync.SchemaFile.fromAsset(path.join(__dirname, '../../graphql/schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          // Using API key for the proof-of-concept.
          // TODO: Replace with Cognito user pool auth before launch.
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            expires: cdk.Expiration.after(cdk.Duration.days(365)),
          },
        },
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ERROR,
      },
      xrayEnabled: false,
    });

    // Wire createTask mutation → Lambda data source
    const createTaskDs = api.addLambdaDataSource('CreateTaskDataSource', createTaskFn);

    createTaskDs.createResolver('CreateTaskResolver', {
      typeName: 'Mutation',
      fieldName: 'createTask',
    });

    // Wire askAi mutation → Bedrock Lambda data source
    const askAiDs = api.addLambdaDataSource('AskAiDataSource', askAiFn);

    askAiDs.createResolver('AskAiResolver', {
      typeName: 'Mutation',
      fieldName: 'askAi',
    });

    // healthCheck query — returns a static string, no data source needed
    const noneDs = api.addNoneDataSource('NoneDataSource');
    noneDs.createResolver('HealthCheckResolver', {
      typeName: 'Query',
      fieldName: 'healthCheck',
      requestMappingTemplate: appsync.MappingTemplate.fromString('{"version":"2018-05-29","payload":{}}'),
      responseMappingTemplate: appsync.MappingTemplate.fromString('"OK"'),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new cdk.CfnOutput(this, 'GraphQLApiKey', { value: api.apiKey ?? '' });
    new cdk.CfnOutput(this, 'TasksTableName', { value: tasksTable.tableName });
    new cdk.CfnOutput(this, 'BedrockModelId', { value: bedrockModelId });
  }
}
