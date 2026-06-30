import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Ai } from './constructs/ai.construct';
import { Api } from './constructs/api.construct';
import { Auth } from './constructs/auth.construct';
import { Database } from './constructs/database.construct';
import { Functions } from './constructs/functions.construct';
import { Storage } from './constructs/storage.construct';

export interface CanPlanBackendStackProps extends cdk.StackProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod', or a personal owner). */
  readonly envName: string;
  /**
   * When true, stateful resources tear down cleanly with `cdk destroy`, leaving
   * no retained tables or buckets behind.
   */
  readonly isDestroyable: boolean;
  /** Bedrock KB id from the Bedrock-region KnowledgeBase stack (cross-region ref). */
  readonly knowledgeBaseId: string;
  /** Region for KB Retrieve + Converse. Must match the KnowledgeBase stack region. */
  readonly bedrockRegion: string;
}

/**
 * Top-level composition: wires the per-domain constructs together and defines
 * the stack outputs. Resource definitions live in `./constructs/*`.
 */
export class CanPlanBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CanPlanBackendStackProps) {
    super(scope, id, props);

    const { envName, isDestroyable, knowledgeBaseId, bedrockRegion } = props;

    // Data + storage
    const database = new Database(this, 'Database', { envName, isDestroyable });
    const storage = new Storage(this, 'Storage', { envName, isDestroyable });

    // Authentication — Cognito user pool, client, and role groups
    const auth = new Auth(this, 'Auth', { envName, isDestroyable });

    // AI config (Bedrock model selection)
    const ai = new Ai(this, 'Ai', { bedrockRegion });

    // Compute — Lambdas depend on the table and the resolved Bedrock config
    const functions = new Functions(this, 'Functions', {
      envName,
      table: database.table,
      mediaBucket: storage.mediaBucket,
      userPool: auth.userPool,
      bedrockModelId: ai.bedrockModelId,
      bedrockRegion: ai.bedrockRegion,
      knowledgeBaseId,
    });

    // GraphQL API — resolvers depend on the Lambdas; Cognito is the primary authorizer
    const api = new Api(this, 'Api', {
      envName,
      userPool: auth.userPool,
      createTaskFn: functions.createTaskFn,
      generateTaskStepsFn: functions.generateTaskStepsFn,
      usersFn: functions.usersFn,
      categoriesFn: functions.categoriesFn,
      tasksFn: functions.tasksFn,
      assignmentsFn: functions.assignmentsFn,
      mediaFn: functions.mediaFn,
      adminFn: functions.adminFn,
      createAiTaskFn: functions.createAiTaskFn,
      reportsFn: functions.reportsFn,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new cdk.CfnOutput(this, 'GraphQLApiKey', { value: api.apiKey });
    // Cognito values the frontend needs — see the README "Authentication" section.
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AwsRegion', { value: this.region });
    new cdk.CfnOutput(this, 'TasksTableName', { value: database.table.tableName });
    new cdk.CfnOutput(this, 'BedrockModelId', { value: ai.bedrockModelId });
    new cdk.CfnOutput(this, 'BedrockRegion', { value: ai.bedrockRegion });
  }
}
