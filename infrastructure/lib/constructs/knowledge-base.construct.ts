import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as oss from 'aws-cdk-lib/aws-opensearchserverless';
import { bedrock, opensearchserverless } from '@cdklabs/generative-ai-cdk-constructs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface KnowledgeBaseProps {
  readonly envName: string;
  readonly isSandbox: boolean;
}

/**
 * Bedrock Knowledge Base over the HealthLink BC corpus, backed by an Amazon
 * OpenSearch Serverless vector collection and titan-embed-text-v2 (1024-dim).
 * Chunking is NONE (one S3 object = one chunk = one chunk_id), preserving the
 * prototype's 1:1 chunk_id↔passage mapping.
 *
 * Uses the AWS Labs GenAI CDK constructs (`@cdklabs/generative-ai-cdk-constructs`),
 * which provision the OSS collection (+ encryption/network/data-access policies
 * and the vector index, via the library's own custom resource) and the Bedrock
 * KB + S3 data source. S3 Vectors was the original store, but its creation is
 * denied by the org SCP in this account, so the KB uses OpenSearch Serverless.
 */
export class KnowledgeBase extends Construct {
  public readonly knowledgeBaseId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    const { envName, isSandbox } = props;
    const removalPolicy = isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const account = cdk.Stack.of(this).account;

    // Corpus data-source bucket + the 160 generated per-passage objects.
    const corpusBucket = new s3.Bucket(this, 'CorpusBucket', {
      bucketName: `canplan-kb-corpus-${envName}-${account}`,
      removalPolicy,
      autoDeleteObjects: isSandbox,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    new s3deploy.BucketDeployment(this, 'CorpusDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../data/corpus/dist'))],
      destinationBucket: corpusBucket,
    });

    // OpenSearch Serverless vector collection (the KB's vector store). Standby
    // replicas off in sandbox to keep OCU usage minimal; on for dev/prod.
    const collection = new opensearchserverless.VectorCollection(this, 'VectorCollection', {
      collectionName: `canplan-kb-${envName}`,
      standbyReplicas: isSandbox
        ? opensearchserverless.VectorCollectionStandbyReplicas.DISABLED
        : opensearchserverless.VectorCollectionStandbyReplicas.ENABLED,
    });
    // The L2 has no default CfnResource child, so apply the removal policy on
    // the underlying CfnCollection (the L2's 'VectorCollection' child) directly.
    (collection.node.findChild('VectorCollection') as oss.CfnCollection).applyRemovalPolicy(
      removalPolicy,
    );

    // Bedrock KB on that collection, embedding with titan-embed-text-v2 (1024).
    // The library auto-creates the vector index inside the collection.
    const kb = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
      embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
      vectorStore: collection,
    });

    // S3 data source — chunking NONE so one object = one chunk = one chunk_id.
    new bedrock.S3DataSource(this, 'CorpusDataSource', {
      knowledgeBase: kb,
      bucket: corpusBucket,
      dataSourceName: `canplan-kb-corpus-${envName}`,
      chunkingStrategy: bedrock.ChunkingStrategy.NONE,
    });

    this.knowledgeBaseId = kb.knowledgeBaseId;
  }
}
