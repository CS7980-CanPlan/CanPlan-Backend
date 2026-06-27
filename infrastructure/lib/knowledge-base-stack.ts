import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { KnowledgeBase } from './constructs/knowledge-base.construct';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod', or a personal owner). */
  readonly envName: string;
  /**
   * When true, stateful resources tear down cleanly with `cdk destroy`, leaving
   * no retained buckets behind.
   */
  readonly isDestroyable: boolean;
}

/**
 * Dedicated Bedrock-region stack for the Bedrock Knowledge Base.
 *
 * A CDK stack deploys to a single region, but the KB resources
 * (CfnKnowledgeBase, S3 Vectors, titan-embed-text-v2, corpus bucket) must live
 * in the Bedrock region — that's where the embedding model must be available and
 * the org SCP must allow access. The rest of the backend stays in ca-central-1,
 * so the KB is split out here and its id is handed to the backend
 * stack via a cross-region reference (`crossRegionReferences: true`).
 */
export class KnowledgeBaseStack extends cdk.Stack {
  public readonly knowledgeBaseId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    const { envName, isDestroyable } = props;

    // Corpus bucket + Bedrock KB (S3 Vectors store). bedrockRegion = this stack's
    // own region so the embedding-model ARN stays self-consistent.
    const knowledgeBase = new KnowledgeBase(this, 'KnowledgeBase', {
      envName,
      isDestroyable,
      bedrockRegion: this.region,
    });

    this.knowledgeBaseId = knowledgeBase.knowledgeBaseId;

    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.knowledgeBaseId });
  }
}
