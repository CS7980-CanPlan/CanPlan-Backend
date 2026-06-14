import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { KnowledgeBase } from './constructs/knowledge-base.construct';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod') — used to namespace resources. */
  readonly envName: string;
  /**
   * When true, all resources tear down cleanly with `cdk destroy` — no retained
   * buckets left behind to incur cost or block the next deploy on a name
   * collision. Set for sandbox only; leave false (RETAIN) for dev / prod.
   */
  readonly isSandbox: boolean;
}

/**
 * Dedicated us-east-1 stack for the Bedrock Knowledge Base.
 *
 * A CDK stack deploys to a single region, but the KB resources
 * (CfnKnowledgeBase, OpenSearch Serverless, titan-embed-text-v2, corpus bucket) must live
 * in us-east-1 — that's where the embedding model is available and the only
 * region validated against the org SCP. The rest of the backend stays in
 * ca-central-1, so the KB is split out here and its id is handed to the backend
 * stack via a cross-region reference (`crossRegionReferences: true`).
 */
export class KnowledgeBaseStack extends cdk.Stack {
  public readonly knowledgeBaseId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    const { envName, isSandbox } = props;

    // Corpus bucket + Bedrock KB (OpenSearch Serverless vector store). The KB's
    // embedding-model ARN resolves to this stack's region (us-east-1).
    const knowledgeBase = new KnowledgeBase(this, 'KnowledgeBase', {
      envName,
      isSandbox,
    });

    this.knowledgeBaseId = knowledgeBase.knowledgeBaseId;

    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.knowledgeBaseId });
  }
}
