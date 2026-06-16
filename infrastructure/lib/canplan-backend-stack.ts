import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Ai } from './constructs/ai.construct';
import { Api } from './constructs/api.construct';
import { Auth } from './constructs/auth.construct';
import { Database } from './constructs/database.construct';
import { Functions } from './constructs/functions.construct';
import { Storage } from './constructs/storage.construct';

export interface CanPlanBackendStackProps extends cdk.StackProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod') — used to namespace resources. */
  readonly envName: string;
  /**
   * When true, all resources tear down cleanly with `cdk destroy` — no retained
   * tables or buckets left behind to incur cost or block the next deploy on a
   * name collision. Set for sandbox only; leave false (RETAIN) for dev / prod.
   */
  readonly isSandbox: boolean;
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

    const { envName, isSandbox, knowledgeBaseId, bedrockRegion } = props;

    // Data + storage
    const database = new Database(this, 'Database', { envName, isSandbox });
    new Storage(this, 'Storage', { envName, isSandbox });

    // Authentication — Cognito user pool, client, and role groups
    const auth = new Auth(this, 'Auth', { envName, isSandbox });

    // AI config (Bedrock model selection)
    const ai = new Ai(this, 'Ai', { bedrockRegion });

    // Compute — Lambdas depend on the table and the resolved Bedrock config
    const functions = new Functions(this, 'Functions', {
      envName,
      table: database.table,
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
      tasksFn: functions.tasksFn,
      assignmentsFn: functions.assignmentsFn,
      progressFn: functions.progressFn,
      mediaFn: functions.mediaFn,
      adminFn: functions.adminFn,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new cdk.CfnOutput(this, 'GraphQLApiKey', { value: api.apiKey });
    // Cognito values the frontend needs — see README "Authentication setup".
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AwsRegion', { value: this.region });
    new cdk.CfnOutput(this, 'TasksTableName', { value: database.table.tableName });
    new cdk.CfnOutput(this, 'BedrockModelId', { value: ai.bedrockModelId });
    new cdk.CfnOutput(this, 'BedrockRegion', { value: ai.bedrockRegion });
  }
}
