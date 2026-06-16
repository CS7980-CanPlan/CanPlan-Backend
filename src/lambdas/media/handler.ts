import { randomUUID } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, MEDIA_PREFIX, mediaSk, taskPk } from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { DOWNLOAD_URL_TTL_SECONDS, MEDIA_BUCKET, s3, UPLOAD_URL_TTL_SECONDS } from '../../shared/s3';
import type {
  AppSyncEvent,
  Connection,
  CreateMediaAssetInput,
  CreateMediaUploadUrlInput,
  MediaAsset,
  MediaDownloadTarget,
  MediaUploadTarget,
} from '../../shared/types';

/**
 * Media domain Lambda — mint a presigned S3 upload URL, record metadata for a media
 * asset (IMAGE / AUDIO / VIDEO), and list a task's media. The binary stays in S3;
 * DynamoDB only stores the s3Key and descriptive metadata. Routed by GraphQL field.
 *
 * Upload flow: createMediaUploadUrl → client PUTs the file to the returned uploadUrl
 * → createMediaAsset registers the metadata for the now-uploaded object.
 * Download: getMediaDownloadUrl returns a short-lived presigned GET for private media.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<MediaAsset | Connection<MediaAsset> | MediaUploadTarget | MediaDownloadTarget> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createMediaUploadUrl':
      return createMediaUploadUrl(args.input as CreateMediaUploadUrlInput);
    case 'createMediaAsset':
      return createMediaAsset(args.input as CreateMediaAssetInput);
    case 'getMediaDownloadUrl':
      return getMediaDownloadUrl(args.taskId as string, args.assetId as string);
    case 'listMediaForTask':
      return listMediaForTask(args.taskId as string, pageArgs(args));
    default:
      throw new Error(`media handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/**
 * Presigned GET for a registered media asset. Looks the asset up first so we only
 * ever sign keys that actually exist (no arbitrary-key probing), then signs its s3Key.
 */
async function getMediaDownloadUrl(taskId: string, assetId: string): Promise<MediaDownloadTarget> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required and cannot be empty');
  if (!assetId?.trim()) throw new ValidationError('assetId is required and cannot be empty');

  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(assetId) } }),
  );
  const asset = result.Item as MediaAsset | undefined;
  if (!asset) throw new NotFoundError('media asset not found');

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: asset.s3Key }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );

  return { downloadUrl, s3Key: asset.s3Key, expiresIn: DOWNLOAD_URL_TTL_SECONDS };
}

async function createMediaUploadUrl(input: CreateMediaUploadUrlInput): Promise<MediaUploadTarget> {
  const taskId = input?.taskId?.trim();
  const contentType = input?.contentType?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!contentType) throw new ValidationError('contentType is required (e.g. image/png)');

  // Server-owned key under the task's prefix; the random id avoids collisions and
  // keeps clients from choosing arbitrary paths.
  const ext = fileExtension(input.fileName, contentType);
  const s3Key = `media/${taskId}/${randomUUID()}${ext ? `.${ext}` : ''}`;

  // Presigning is a local signing operation (no S3 call). The URL inherits this
  // Lambda's s3:PutObject permission, scoped by the bucket policy + the key above.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: s3Key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  return { uploadUrl, s3Key, expiresIn: UPLOAD_URL_TTL_SECONDS };
}

/** Best-effort file extension: prefer the fileName's, fall back to the content subtype. */
function fileExtension(fileName: string | undefined, contentType: string): string | undefined {
  if (fileName && fileName.includes('.')) {
    const ext = fileName.split('.').pop()?.trim().toLowerCase();
    if (ext) return ext;
  }
  const subtype = contentType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  return subtype || undefined;
}

async function createMediaAsset(input: CreateMediaAssetInput): Promise<MediaAsset> {
  const taskId = input?.taskId?.trim();
  const s3Key = input?.s3Key?.trim();
  const mimeType = input?.mimeType?.trim();
  const ownerId = input?.ownerId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!s3Key) throw new ValidationError('s3Key is required and cannot be empty');
  if (!input?.type) throw new ValidationError('type is required (IMAGE, AUDIO, or VIDEO)');
  if (!mimeType) throw new ValidationError('mimeType is required and cannot be empty');
  if (!ownerId) throw new ValidationError('ownerId is required and cannot be empty');

  const now = new Date().toISOString();
  const asset: MediaAsset = {
    assetId: randomUUID(),
    taskId,
    stepId: input.stepId?.trim(),
    s3Key,
    type: input.type,
    mimeType,
    ownerId,
    size: input.size,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: taskPk(taskId), SK: mediaSk(asset.assetId), entityType: ENTITY.MEDIA_ASSET, ...asset },
    }),
  );

  return asset;
}

async function listMediaForTask(taskId: string, page: PageArgs): Promise<Connection<MediaAsset>> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  return queryPage<MediaAsset>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': taskPk(taskId), ':prefix': MEDIA_PREFIX },
    },
    page,
  );
}
