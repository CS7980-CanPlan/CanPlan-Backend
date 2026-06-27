import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import * as path from 'path';

export interface KnowledgeBaseProps {
  readonly envName: string;
  readonly isDestroyable: boolean;
  /** Region the KB + embedding model live in (us-east-1). */
  readonly bedrockRegion: string;
}

/**
 * Bedrock Knowledge Base over the HealthLink BC corpus, using an S3 Vectors store
 * and titan-embed-text-v2. Chunking is NONE (one S3 object = one chunk = one
 * chunk_id), preserving the prototype's 1:1 chunk_id↔passage mapping.
 *
 * Uses the first-class S3 Vectors L1 resources (aws-cdk-lib >= 2.259):
 * CfnVectorBucket + CfnIndex, bound to the KB via storageConfiguration.S3_VECTORS.
 */
export class KnowledgeBase extends Construct {
  public readonly knowledgeBaseId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    const { envName, isDestroyable, bedrockRegion } = props;
    const removalPolicy = isDestroyable ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const account = cdk.Stack.of(this).account;
    const embeddingModelArn = `arn:aws:bedrock:${bedrockRegion}::foundation-model/amazon.titan-embed-text-v2:0`;
    const vectorBucketName = `canplan-kb-vectors-${envName}-${account}`;

    // Corpus data-source bucket + the 160 generated per-passage objects.
    const corpusBucket = new s3.Bucket(this, 'CorpusBucket', {
      bucketName: `canplan-kb-corpus-${envName}-${account}`,
      removalPolicy,
      autoDeleteObjects: isDestroyable,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    new s3deploy.BucketDeployment(this, 'CorpusDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../data/corpus/dist'))],
      destinationBucket: corpusBucket,
    });

    // IAM role Bedrock assumes to read the corpus + invoke the embedding model.
    const kbRole = new iam.Role(this, 'KbRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    corpusBucket.grantRead(kbRole);
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [embeddingModelArn],
      }),
    );

    // S3 Vectors store: a vector bucket + an index sized to titan-embed-v2.
    // dataType/distanceMetric values confirmed by `cdk synth` (Risk #2).
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName,
    });
    vectorBucket.applyRemovalPolicy(removalPolicy);
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      indexName: 'canplan-kb-index',
      vectorBucketName,
      dataType: 'float32',
      dimension: 1024, // titan-embed-text-v2 default output dimension
      distanceMetric: 'cosine',
    });
    vectorIndex.applyRemovalPolicy(removalPolicy);
    vectorIndex.addDependency(vectorBucket);
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:*'],
        resources: [vectorBucket.attrVectorBucketArn, vectorIndex.attrIndexArn],
      }),
    );

    // Bedrock Knowledge Base bound to the S3 Vectors index.
    const cfnKb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `canplan-kb-${envName}`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: { embeddingModelArn },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: vectorIndex.attrIndexArn,
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
        },
      },
    });
    cfnKb.addDependency(vectorIndex);
    // The KB validates its storage config at create time by calling s3vectors on
    // the index *as kbRole*, so it must wait for kbRole's inline policy to attach
    // — not just the role itself. node.addDependency on the L2 role makes the KB
    // depend on the role's DefaultPolicy too; without it the KB races ahead of
    // the policy and fails with a 403 on s3vectors:QueryVectors.
    cfnKb.node.addDependency(kbRole);

    // S3 data source — chunking NONE so one object = one chunk.
    new bedrock.CfnDataSource(this, 'CorpusDataSource', {
      name: `canplan-kb-corpus-${envName}`,
      knowledgeBaseId: cfnKb.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: { bucketArn: corpusBucket.bucketArn },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: { chunkingStrategy: 'NONE' },
      },
    });

    this.knowledgeBaseId = cfnKb.attrKnowledgeBaseId;
  }
}
