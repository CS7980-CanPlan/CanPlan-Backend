import { randomUUID } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { queryAllItems } from '../../shared/batch';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, MEDIA_PREFIX, mediaSk, META_SK, STEP_PREFIX, stepSk, taskPk } from '../../shared/keys';
import {
  deleteS3ObjectBestEffort,
  isAllowedImageMime,
  ALLOWED_IMAGE_MIME_TYPES,
  pendingCoverKey,
} from '../../shared/media';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { DOWNLOAD_URL_TTL_SECONDS, MEDIA_BUCKET, s3, UPLOAD_URL_TTL_SECONDS } from '../../shared/s3';
import type {
  AppSyncEvent,
  Connection,
  CreateMediaAssetInput,
  CreateMediaUploadUrlInput,
  CreateTaskCoverImageUploadUrlInput,
  DeleteMediaAssetInput,
  MediaAsset,
  MediaDownloadTarget,
  MediaUploadTarget,
  TaskStep,
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
    case 'createTaskCoverImageUploadUrl':
      return createTaskCoverImageUploadUrl(args.input as CreateTaskCoverImageUploadUrlInput);
    case 'createMediaAsset':
      return createMediaAsset(args.input as CreateMediaAssetInput);
    case 'deleteMediaAsset':
      return deleteMediaAsset(args.input as DeleteMediaAssetInput);
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

/**
 * Mint a presigned PUT URL for a task cover image, under the server-owned *pending*
 * prefix. There's no taskId yet (the task may not exist), so the object lands in
 * `media/pending/task-cover/` and createTask/updateTask promotes it to a task-owned key
 * after verifying it. Only image content types are accepted (the upload is re-verified
 * server-side too — this is a fast-fail, not the security boundary).
 */
async function createTaskCoverImageUploadUrl(
  input: CreateTaskCoverImageUploadUrlInput,
): Promise<MediaUploadTarget> {
  const contentType = input?.contentType?.trim().toLowerCase();
  if (!contentType) {
    throw new ValidationError('contentType is required (image/jpeg, image/png, or image/webp)');
  }
  if (!isAllowedImageMime(contentType)) {
    throw new ValidationError(`contentType must be one of ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`);
  }

  const s3Key = pendingCoverKey(contentType);
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

/**
 * deleteMediaAsset — delete one media asset's S3 binary and its metadata row, after
 * removing every API-visible reference to it.
 *
 * Consistency strategy (S3 + DynamoDB are not transactional): we clear references and
 * delete the DynamoDB row FIRST, then delete the S3 object. This deliberately prefers a
 * (logged, recoverable) orphaned S3 file over a database reference to a missing file —
 * the API never points at a binary that's gone. The operation is idempotent/retryable:
 * a re-run after the row is deleted returns NotFound, and S3 DeleteObject is a no-op for
 * an already-absent key. An S3 delete failure is logged with full context (never
 * silently ignored) for a retry/cleanup job; it does not resurrect the reference.
 *
 * Sharing: each MediaAsset belongs to exactly one Task (PK=TASK#<taskId>) and is owned/
 * deleted with that task — assets are not shared across tasks, so no cross-task
 * reference check is required before deleting the binary.
 */
async function deleteMediaAsset(input: DeleteMediaAssetInput): Promise<MediaAsset> {
  const taskId = input?.taskId?.trim();
  const assetId = input?.assetId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!assetId) throw new ValidationError('assetId is required and cannot be empty');

  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(assetId) } }),
  );
  const asset = result.Item as MediaAsset | undefined;
  if (!asset) throw new NotFoundError('media asset not found');

  // Remove dangling references before deleting the row (each step is idempotent).
  await clearTaskCoverReference(taskId, assetId);
  await removeAssetFromTaskSteps(taskId, assetId);

  // Delete the metadata row, then the binary (DB-first — see the function comment).
  await dynamo.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(assetId) } }),
  );
  await deleteS3ObjectBestEffort(asset.s3Key, { event: 'deleteMediaAsset', taskId, assetId });

  const out: Record<string, unknown> = { ...asset };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  return out as unknown as MediaAsset;
}

/** Clear Task.coverImageAssetId iff it currently points at this asset (no-op otherwise). */
async function clearTaskCoverReference(taskId: string, assetId: string): Promise<void> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: META_SK },
        UpdateExpression: 'REMOVE coverImageAssetId',
        // Only touch the task if this asset is actually its cover.
        ConditionExpression: 'coverImageAssetId = :assetId',
        ExpressionAttributeValues: { ':assetId': assetId },
      }),
    );
  } catch (err) {
    // Not the cover (or the task is gone) — nothing to clear.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

/** Remove assetId from mediaRefs on every TaskStep that references it (paginated). */
async function removeAssetFromTaskSteps(taskId: string, assetId: string): Promise<void> {
  const steps = await queryAllItems<TaskStep>(taskPk(taskId), STEP_PREFIX);
  const now = new Date().toISOString();
  for (const step of steps) {
    if (!step.mediaRefs?.includes(assetId)) continue;
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: stepSk(step.order) },
        UpdateExpression: 'SET mediaRefs = :refs, updatedAt = :now',
        ExpressionAttributeValues: {
          ':refs': step.mediaRefs.filter((ref) => ref !== assetId),
          ':now': now,
        },
      }),
    );
  }
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
