import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageProps {
  /** Environment name — keeps the bucket unique per environment in an account. */
  readonly envName: string;
  /** Destroyable environments empty + delete on teardown; dev/prod RETAIN. */
  readonly isDestroyable: boolean;
}

/** S3 storage for CanPlan (media uploads, future use). */
export class Storage extends Construct {
  public readonly mediaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const { envName, isDestroyable } = props;
    const { account, region } = cdk.Stack.of(this);

    this.mediaBucket = new s3.Bucket(this, 'CanPlanMediaBucket', {
      bucketName: `canplan-media-${envName}-${account}-${region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Allow browser clients to PUT to presigned upload URLs (createMediaUploadUrl)
      // and GET media back. `*` origins are fine for dev — restrict to the web
      // portal origin(s) for prod.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      // Expire abandoned cover-image uploads. Clients request a presigned PUT to a
      // pending key (media/pending/task-cover/) and only some get promoted to a
      // task-owned key by createTask/updateTask; the rest are never referenced. Reclaim
      // them after 24h so failed/abandoned uploads don't accumulate.
      lifecycleRules: [
        {
          id: 'expire-pending-task-cover-uploads',
          prefix: 'media/pending/task-cover/',
          expiration: cdk.Duration.days(1),
        },
        {
          id: 'expire-generated-report-pdf-cache',
          prefix: 'report-pdf-cache/',
          expiration: cdk.Duration.days(1),
        },
      ],
      // Destroyable environments empty + delete on teardown. dev / prod retain.
      removalPolicy: isDestroyable ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: isDestroyable,
    });
  }
}
