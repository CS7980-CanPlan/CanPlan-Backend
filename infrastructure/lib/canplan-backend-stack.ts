import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
  }
}
