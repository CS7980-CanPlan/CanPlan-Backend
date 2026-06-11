import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageProps {
  /** Environment name — keeps the bucket unique per environment in an account. */
  readonly envName: string;
  /** Sandbox empties + deletes on teardown; dev/prod RETAIN. */
  readonly isSandbox: boolean;
}

/** S3 storage for CanPlan (media uploads, future use). */
export class Storage extends Construct {
  public readonly mediaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const { envName, isSandbox } = props;
    const { account, region } = cdk.Stack.of(this);

    this.mediaBucket = new s3.Bucket(this, 'CanPlanMediaBucket', {
      bucketName: `canplan-media-${envName}-${account}-${region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Sandbox: empty + delete on teardown. dev / prod: retain.
      removalPolicy: isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: isSandbox,
    });
  }
}
