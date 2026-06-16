import { S3Client } from '@aws-sdk/client-s3';

// Single shared S3 client reused across Lambda invocations. The media bucket lives
// in the backend region (same as the Lambda's AWS_REGION), so — unlike Bedrock —
// no separate region is needed.
export const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ca-central-1' });

// Media bucket name, injected by the CDK Functions construct.
export const MEDIA_BUCKET = process.env.MEDIA_BUCKET_NAME ?? '';

// How long a presigned upload URL stays valid (seconds). Short by default so a
// leaked URL is low-risk; the client uploads immediately after requesting it.
export const UPLOAD_URL_TTL_SECONDS = Number(process.env.UPLOAD_URL_TTL_SECONDS ?? '900');
