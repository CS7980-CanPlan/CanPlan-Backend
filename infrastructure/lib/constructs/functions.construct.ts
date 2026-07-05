import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface FunctionsProps {
  readonly envName: string;
  /** Single-table store the data Lambdas read from / write to. */
  readonly table: dynamodb.ITable;
  /** Media bucket the media Lambda mints presigned upload URLs for. */
  readonly mediaBucket: s3.IBucket;
  /** User Pool the admin Lambda manages (invite / role / delete) — scopes its Cognito IAM. */
  readonly userPool: cognito.IUserPool;
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
  public readonly createAiTaskFn: NodejsFunction;
  public readonly reportsFn: NodejsFunction;
  /** Domain Lambdas — each backs several fields of one domain (routed by fieldName). */
  public readonly usersFn: NodejsFunction;
  public readonly categoriesFn: NodejsFunction;
  public readonly tasksFn: NodejsFunction;
  public readonly assignmentsFn: NodejsFunction;
  public readonly mediaFn: NodejsFunction;
  /** SystemAdmin-only list-all-by-entityType APIs (read-only). */
  public readonly adminFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: FunctionsProps) {
    super(scope, id);

    const {
      envName,
      table,
      mediaBucket,
      userPool,
      bedrockModelId,
      bedrockRegion,
      knowledgeBaseId,
    } = props;

    // Shared factory for a DynamoDB-backed resolver Lambda. Each gets the table
    // name in its env and connection reuse enabled.
    const dataFn = (construct: string, fnName: string, dir: string): NodejsFunction =>
      new NodejsFunction(this, construct, {
        functionName: `canplan-${fnName}-${envName}`,
        entry: path.join(__dirname, `../../../src/lambdas/${dir}/handler.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        environment: {
          DYNAMODB_TABLE_NAME: table.tableName,
          AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        timeout: cdk.Duration.seconds(10),
      });

    // Cover-image S3 access for the Lambdas that verify + promote a pending upload
    // (HeadObject = s3:GetObject, CopyObject = GetObject on the source + PutObject on the
    // destination) and clean up temp/old objects (DeleteObject). Least-privilege: only
    // the functions that touch cover images get these, scoped to the media bucket.
    const grantCoverImageS3 = (fn: NodejsFunction): void => {
      fn.addEnvironment('MEDIA_BUCKET_NAME', mediaBucket.bucketName);
      mediaBucket.grantRead(fn); // HeadObject + CopyObject source
      mediaBucket.grantPut(fn); // CopyObject destination
      mediaBucket.grantDelete(fn); // temp + replaced/cascaded object cleanup
    };

    // ── createTask ──────────────────────────────────────────────────────────────
    // Writes a Task #META item plus its TaskStep items (and an optional cover-image
    // MediaAsset) in one transaction. Reads the owner's profile (default category) and
    // validates the chosen category, so it needs read + write on the table.
    this.createTaskFn = dataFn('CreateTaskFunction', 'createTask', 'createTask');
    table.grantReadWriteData(this.createTaskFn);
    grantCoverImageS3(this.createTaskFn);

    // ── Domain Lambdas (read + write the single table, incl. its GSIs) ──────────
    this.usersFn = dataFn('UsersFunction', 'users', 'users');
    this.categoriesFn = dataFn('CategoriesFunction', 'categories', 'categories');
    this.tasksFn = dataFn('TasksFunction', 'tasks', 'tasks');
    this.assignmentsFn = dataFn('AssignmentsFunction', 'assignments', 'assignments');
    this.mediaFn = dataFn('MediaFunction', 'media', 'media');

    for (const fn of [
      this.usersFn,
      this.categoriesFn,
      this.tasksFn,
      this.assignmentsFn,
      this.mediaFn,
    ]) {
      // grantReadWriteData also covers the table's GSIs (table-arn/index/*).
      table.grantReadWriteData(fn);
    }

    // admin — SystemAdmin-only listings PLUS Cognito role management and destructive data
    // APIs (delete any task, full user deletion). Needs table read+write (incl. GSIs), the
    // same media-bucket cleanup access as the tasks Lambda, and scoped Cognito admin actions.
    this.adminFn = dataFn('AdminFunction', 'admin', 'admin');
    table.grantReadWriteData(this.adminFn);
    grantCoverImageS3(this.adminFn); // S3 read/put/delete for task-media cascade cleanup
    this.adminFn.addEnvironment('USER_POOL_ID', userPool.userPoolId);
    // Least-privilege Cognito admin actions, scoped to the deployed User Pool. No circular
    // dependency: the admin Lambda is not a trigger ON the pool (unlike postConfirmation), so
    // it can reference the concrete pool ARN directly.
    this.adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:ListUsers',
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    // The media Lambda mints presigned S3 URLs (createMediaUploadUrl /
    // createTaskCoverImageUploadUrl / getMediaDownloadUrl); each signed URL inherits the
    // Lambda's s3:PutObject / s3:GetObject permission here. deleteMediaAsset also removes
    // the underlying object directly, so it needs s3:DeleteObject.
    this.mediaFn.addEnvironment('MEDIA_BUCKET_NAME', mediaBucket.bucketName);
    mediaBucket.grantPut(this.mediaFn);
    mediaBucket.grantRead(this.mediaFn);
    mediaBucket.grantDelete(this.mediaFn);

    // updateTask replaces cover images (verify + promote pending upload, then clean up
    // the old one) and deleteTask cascades to all task-owned media binaries.
    grantCoverImageS3(this.tasksFn);

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
        RERANK_COARSE_K: '25',
        RERANK_MODEL_ID: 'cohere.rerank-v3-5:0',
        RERANK_SCORE_FLOOR: '0.3',
        RERANK_REL_RATIO: '0.5',
        RERANK_MIN_RESULTS: '2',
        RERANK_MAX_RESULTS: '5',
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
    // KB Retrieve — scoped to the one Knowledge Base in the Bedrock region.
    this.generateTaskStepsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}:${cdk.Stack.of(this).account}:knowledge-base/${knowledgeBaseId}`,
        ],
      }),
    );
    // Standalone Rerank (stage 2). bedrock:Rerank is NOT a model-scoped action —
    // it only authorizes against "*" (per AWS reranking permissions docs); only
    // bedrock:InvokeModel is scoped to the Cohere reranker in the Bedrock region.
    // NOTE: this ARN is hardcoded to cohere.rerank-v3-5:0 and must be kept in sync
    // with the RERANK_MODEL_ID env var below — overriding that env without updating
    // this ARN denies InvokeModel at runtime (us-east-1 has no other reranker today).
    this.generateTaskStepsFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:Rerank'], resources: ['*'] }),
    );
    this.generateTaskStepsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}::foundation-model/cohere.rerank-v3-5:0`,
        ],
      }),
    );

    // ── createAiTask (Bedrock KB + RAG; returns a preview, persists nothing) ─────
    this.createAiTaskFn = new NodejsFunction(this, 'CreateAiTaskFunction', {
      functionName: `canplan-createAiTask-${envName}`,
      entry: path.join(__dirname, '../../../src/lambdas/createAiTask/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_MODEL_ID: bedrockModelId,
        BEDROCK_MAX_TOKENS: '1024',
        KNOWLEDGE_BASE_ID: knowledgeBaseId,
        RERANK_COARSE_K: '25',
        RERANK_MODEL_ID: 'cohere.rerank-v3-5:0',
        RERANK_SCORE_FLOOR: '0.3',
        RERANK_REL_RATIO: '0.5',
        RERANK_MIN_RESULTS: '2',
        RERANK_MAX_RESULTS: '5',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
    });

    // No DynamoDB grant — createAiTask only generates a preview and never persists.

    // Converse (Sonnet) — same cross-region inference-profile grant as generateTaskSteps.
    this.createAiTaskFn.addToRolePolicy(
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
    // KB Retrieve — scoped to the one Knowledge Base in the Bedrock region.
    this.createAiTaskFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}:${cdk.Stack.of(this).account}:knowledge-base/${knowledgeBaseId}`,
        ],
      }),
    );
    // Standalone Rerank (stage 2). bedrock:Rerank is NOT a model-scoped action —
    // it only authorizes against "*" (per AWS reranking permissions docs); only
    // bedrock:InvokeModel is scoped to the Cohere reranker in the Bedrock region.
    // NOTE: this ARN is hardcoded to cohere.rerank-v3-5:0 and must be kept in sync
    // with the RERANK_MODEL_ID env var below — overriding that env without updating
    // this ARN denies InvokeModel at runtime (us-east-1 has no other reranker today).
    this.createAiTaskFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:Rerank'], resources: ['*'] }),
    );
    this.createAiTaskFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}::foundation-model/cohere.rerank-v3-5:0`,
        ],
      }),
    );

    // ── reports (Bedrock Converse over pre-computed stats; persists to DynamoDB + S3) ─
    this.reportsFn = new NodejsFunction(this, 'ReportsFunction', {
      functionName: `canplan-reports-${envName}`,
      entry: path.join(__dirname, '../../../src/lambdas/reports/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: {
        DYNAMODB_TABLE_NAME: table.tableName,
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_MODEL_ID: bedrockModelId,
        BEDROCK_MAX_TOKENS: '1024',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
    });
    // Reads instances/steps/tasks/categories/support-links; writes the Report row.
    table.grantReadWriteData(this.reportsFn);
    // Writes the report JSON, signs a GET for it, and deletes it on deleteReport (no KB retrieval).
    mediaBucket.grantPut(this.reportsFn);
    mediaBucket.grantRead(this.reportsFn);
    mediaBucket.grantDelete(this.reportsFn);
    // Converse (Sonnet) — same cross-region inference-profile grant as createAiTask.
    this.reportsFn.addToRolePolicy(
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
