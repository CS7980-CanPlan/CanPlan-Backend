import { randomUUID } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertCallerOwns, requireCaller } from '../../shared/authz';
import { assertCanReadTaskById } from '../../shared/delegation';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, MEDIA_PREFIX, mediaSk, taskPk } from '../../shared/keys';
import {
  isAllowedImageMime,
  ALLOWED_IMAGE_MIME_TYPES,
  pendingCoverKey,
  purgeMediaAsset,
} from '../../shared/media';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/response';
import { DOWNLOAD_URL_TTL_SECONDS, MEDIA_BUCKET, s3, UPLOAD_URL_TTL_SECONDS } from '../../shared/s3';
import { readTaskMeta } from '../../shared/taskCascade';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  Connection,
  CreateMediaAssetInput,
  CreateMediaUploadUrlInput,
  CreateTaskCoverImageUploadUrlInput,
  DeleteMediaAssetInput,
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
 *
 * Authorization: media operations are scoped to the task's owner. Write/mint operations
 * (createMediaUploadUrl, createMediaAsset, deleteMediaAsset) are owner-only — the caller's
 * Cognito `sub` must equal the task's `ownerId`. Reads (getMediaDownloadUrl, listMediaForTask)
 * additionally allow a caller who holds an ACTIVE TaskAssignment referencing the task (an
 * assigned primary user can view a SupportPerson's task media), but never mutate it.
 * createTaskCoverImageUploadUrl only requires an authenticated caller (no task exists yet).
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<MediaAsset | Connection<MediaAsset> | MediaUploadTarget | MediaDownloadTarget> => {
  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    case 'createMediaUploadUrl':
      return createMediaUploadUrl(args.input as CreateMediaUploadUrlInput, identity);
    case 'createTaskCoverImageUploadUrl':
      return createTaskCoverImageUploadUrl(args.input as CreateTaskCoverImageUploadUrlInput, identity);
    case 'createMediaAsset':
      return createMediaAsset(args.input as CreateMediaAssetInput, identity);
    case 'deleteMediaAsset':
      return deleteMediaAsset(args.input as DeleteMediaAssetInput, identity);
    case 'getMediaDownloadUrl':
      return getMediaDownloadUrl(args.taskId as string, args.assetId as string, identity);
    case 'listMediaForTask':
      return listMediaForTask(args.taskId as string, pageArgs(args), identity);
    default:
      throw new Error(`media handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/**
 * Assert the caller OWNS the task a media write targets (media writes are owner-only). Reads the
 * authoritative owner from the task #META row, not a client-supplied ownerId.
 */
async function assertOwnsTask(
  identity: AppSyncIdentity | undefined,
  taskId: string,
): Promise<void> {
  const task = await readTaskMeta(taskId);
  if (!task) throw new NotFoundError(`task ${taskId} not found`);
  assertCallerOwns(identity, task.ownerId);
}

/**
 * Presigned GET for a registered media asset. Looks the asset up first so we only
 * ever sign keys that actually exist (no arbitrary-key probing), then signs its s3Key.
 */
async function getMediaDownloadUrl(
  taskId: string,
  assetId: string,
  identity: AppSyncIdentity | undefined,
): Promise<MediaDownloadTarget> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required and cannot be empty');
  if (!assetId?.trim()) throw new ValidationError('assetId is required and cannot be empty');
  // Read access: the owner, or a user with an active assignment referencing the task. Authorize
  // against the task before revealing whether the asset exists.
  await assertCanReadTaskById(identity, taskId.trim());

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

async function createMediaUploadUrl(
  input: CreateMediaUploadUrlInput,
  identity: AppSyncIdentity | undefined,
): Promise<MediaUploadTarget> {
  const taskId = input?.taskId?.trim();
  const contentType = input?.contentType?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!contentType) throw new ValidationError('contentType is required (e.g. image/png)');
  // Minting an upload URL for a task is owner-only.
  await assertOwnsTask(identity, taskId);

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
  identity: AppSyncIdentity | undefined,
): Promise<MediaUploadTarget> {
  // No taskId exists yet (the task may not exist), so this is authenticated-only; the pending
  // upload is promoted to a task-owned asset later by the owner-scoped createTask/updateTask.
  requireCaller(identity);
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

async function createMediaAsset(
  input: CreateMediaAssetInput,
  identity: AppSyncIdentity | undefined,
): Promise<MediaAsset> {
  const taskId = input?.taskId?.trim();
  const s3Key = input?.s3Key?.trim();
  const mimeType = input?.mimeType?.trim();
  const ownerId = input?.ownerId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!s3Key) throw new ValidationError('s3Key is required and cannot be empty');
  if (!input?.type) throw new ValidationError('type is required (IMAGE, AUDIO, or VIDEO)');
  if (!mimeType) throw new ValidationError('mimeType is required and cannot be empty');
  if (!ownerId) throw new ValidationError('ownerId is required and cannot be empty');
  // Registering media under a task is owner-only.
  await assertOwnsTask(identity, taskId);

  const now = new Date().toISOString();
  // Newly registered media is UNATTACHED (no stepId) — it is bound to a step only via
  // updateTaskStep(media), or promoted to a cover image through the cover flow.
  const asset: MediaAsset = {
    assetId: randomUUID(),
    taskId,
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
 * clearing the single back-reference to it.
 *
 * An asset is referenced by at most one location — the Task cover (Task.coverImageAssetId)
 * OR one TaskStep (MediaAsset.stepId). Step responses derive their media lists from these
 * asset rows, so purgeMediaAsset only clears a cover back-reference when applicable.
 *
 * Consistency strategy (S3 + DynamoDB are not transactional): we clear the reference and
 * delete the DynamoDB row FIRST, then delete the S3 object. This deliberately prefers a
 * (logged, recoverable) orphaned S3 file over a database reference to a missing file —
 * the API never points at a binary that's gone. The operation is idempotent/retryable:
 * a re-run after the row is deleted returns NotFound, and S3 DeleteObject is a no-op for
 * an already-absent key. An S3 delete failure is logged with full context (never
 * silently ignored) for a retry/cleanup job; it does not resurrect the reference.
 */
async function deleteMediaAsset(
  input: DeleteMediaAssetInput,
  identity: AppSyncIdentity | undefined,
): Promise<MediaAsset> {
  const taskId = input?.taskId?.trim();
  const assetId = input?.assetId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!assetId) throw new ValidationError('assetId is required and cannot be empty');
  // Deleting media is owner-only.
  await assertOwnsTask(identity, taskId);

  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(assetId) } }),
  );
  const asset = result.Item as MediaAsset | undefined;
  if (!asset) throw new NotFoundError('media asset not found');

  // Shared cleanup path (also used by deleteTaskStep / deleteTask): clear dangling
  // references, delete the metadata row, then delete the S3 binary. A failed binary
  // delete remains in the durable cleanup journal and is surfaced to the caller rather
  // than being reported as a successful deletion.
  const complete = await purgeMediaAsset(asset, { event: 'deleteMediaAsset' });
  if (!complete) {
    throw new Error(`deleteMediaAsset: media object ${assetId} could not be deleted; retry the operation`);
  }

  const out: Record<string, unknown> = { ...asset };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  return out as unknown as MediaAsset;
}

async function listMediaForTask(
  taskId: string,
  page: PageArgs,
  identity: AppSyncIdentity | undefined,
): Promise<Connection<MediaAsset>> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  // Read access: the owner, or a user with an active assignment referencing the task.
  await assertCanReadTaskById(identity, taskId.trim());
  return queryPage<MediaAsset>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': taskPk(taskId), ':prefix': MEDIA_PREFIX },
    },
    page,
  );
}
