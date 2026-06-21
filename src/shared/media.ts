// Cover-image + media-cleanup helpers shared by the createTask, tasks, and media
// Lambdas — the single source of truth for media S3/DynamoDB cleanup semantics so
// deleteMediaAsset, deleteTaskStep, and deleteTask all behave consistently.
//
// Cover images reuse the existing private-S3 + presigned-PUT architecture: the binary
// never travels through GraphQL. A client uploads to a server-owned *pending* key, then
// the server verifies the real object (HeadObject — never trusting client MIME/size),
// copies it to a task-owned final key, and registers a normal MediaAsset row.

import { randomUUID } from 'crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { queryAllItems } from './batch';
import { dynamo, TABLE_NAME } from './dynamodb';
import {
  ENTITY,
  mediaSk,
  META_SK,
  STEP_PREFIX,
  stepSk,
  taskMediaCleanupSk,
  taskPk,
  TASK_MEDIA_CLEANUP_PREFIX,
} from './keys';
import { NotFoundError, ValidationError } from './response';
import { MEDIA_BUCKET, s3 } from './s3';
import type { MediaAsset, TaskStep } from './types';

/** Cover images accept only these MIME types (verified via HeadObject, not the client). */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** Hard size cap for a cover image (10 MB). */
export const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Server-owned prefix for not-yet-attached cover uploads. An S3 lifecycle rule expires
 * abandoned objects under this prefix after 24h (see the Storage construct).
 */
export const PENDING_COVER_PREFIX = 'media/pending/task-cover/';

/** Canonical file extension per allowed MIME type (used for both pending + final keys). */
const MIME_EXTENSION: Record<AllowedImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isAllowedImageMime(value: string | undefined): value is AllowedImageMimeType {
  return !!value && (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Build a pending cover-upload key under the server-owned prefix for a verified MIME type. */
export function pendingCoverKey(mimeType: AllowedImageMimeType): string {
  return `${PENDING_COVER_PREFIX}${randomUUID()}.${MIME_EXTENSION[mimeType]}`;
}

/**
 * True only for keys that are exactly one segment under the pending prefix — no nested
 * paths, no traversal. Guards against a client passing an arbitrary S3 key to register.
 */
export function isPendingCoverKey(key: string): boolean {
  if (!key.startsWith(PENDING_COVER_PREFIX)) return false;
  const rest = key.slice(PENDING_COVER_PREFIX.length);
  return rest.length > 0 && !rest.includes('/');
}

function isS3NotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Validate a pending cover upload and promote it to a task-owned MediaAsset.
 *
 * Steps: (1) reject any key outside the pending prefix; (2) HeadObject to verify the
 * object exists and read its REAL Content-Type + size (client-declared values are never
 * trusted); (3) enforce allowed image MIME + 0 < size <= 10 MB; (4) copy to the final
 * key `media/<taskId>/<assetId>.<ext>`; (5) best-effort delete the temp object (the 24h
 * lifecycle rule reclaims it if this fails). Returns the unwritten MediaAsset — the
 * CALLER persists the row (atomically, alongside the Task) and is responsible for
 * cleaning up the final S3 object if that DB write fails.
 */
export async function prepareCoverImageAsset(params: {
  taskId: string;
  ownerId: string;
  coverImageS3Key: string;
}): Promise<MediaAsset> {
  const { taskId, ownerId } = params;
  const pendingKey = params.coverImageS3Key?.trim();
  if (!pendingKey) throw new ValidationError('coverImageS3Key is required and cannot be empty');
  if (!isPendingCoverKey(pendingKey)) {
    throw new ValidationError(
      `coverImageS3Key must be a pending upload under "${PENDING_COVER_PREFIX}" (request one via createTaskCoverImageUploadUrl)`,
    );
  }

  // Verify the ACTUAL uploaded object — never trust the client's declared MIME/size.
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: pendingKey }));
  } catch (err) {
    if (isS3NotFound(err)) {
      throw new NotFoundError('uploaded cover image not found; PUT it to the presigned URL first');
    }
    throw err;
  }
  const mimeType = head.ContentType?.trim().toLowerCase();
  const size = head.ContentLength ?? 0;
  if (!isAllowedImageMime(mimeType)) {
    throw new ValidationError(
      `cover image must be one of ${ALLOWED_IMAGE_MIME_TYPES.join(', ')} (got ${mimeType ?? 'unknown'})`,
    );
  }
  if (size <= 0) throw new ValidationError('cover image is empty (zero bytes)');
  if (size > MAX_COVER_IMAGE_BYTES) {
    throw new ValidationError(`cover image exceeds the ${MAX_COVER_IMAGE_BYTES}-byte (10 MB) limit`);
  }

  const assetId = randomUUID();
  const finalKey = `media/${taskId}/${assetId}.${MIME_EXTENSION[mimeType]}`;

  // Promote the verified temp object to its task-owned final key.
  await s3.send(
    new CopyObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: finalKey,
      CopySource: encodeURI(`${MEDIA_BUCKET}/${pendingKey}`),
      ContentType: mimeType,
      MetadataDirective: 'REPLACE',
    }),
  );
  // Temp cleanup is best-effort — the lifecycle rule is the safety net.
  await deleteS3ObjectBestEffort(pendingKey, { event: 'coverImage.tempCleanup', taskId });

  const now = new Date().toISOString();
  return {
    assetId,
    taskId,
    s3Key: finalKey,
    type: 'IMAGE',
    mimeType,
    ownerId,
    size,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Delete an S3 object, swallowing failure into a structured `console.error` log instead
 * of throwing. Used after the database is already free of references to the object, so a
 * failed delete leaves only an orphaned (logged, recoverable) binary — never a DB row or
 * Task reference pointing at a file we intended to remove. Returns whether the delete
 * succeeded so callers can surface it in tests. `context` is merged into the log line so
 * a retry/cleanup job has the task id, asset id, and key it needs.
 */
export async function deleteS3ObjectBestEffort(
  s3Key: string,
  context: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: s3Key }));
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({ event: 's3.deleteFailed', ...context, s3Key, error: String(err) }),
    );
    return false;
  }
}

/** A durable record of an S3 object whose metadata/reference has been removed. */
interface MediaCleanupJournal {
  PK: string;
  SK: string;
  assetId: string;
  s3Key: string;
}

/**
 * Persist an S3 cleanup obligation before the MediaAsset row disappears. This makes a
 * failed S3 delete recoverable even after the caller has removed all live references.
 */
async function journalMediaCleanup(asset: Pick<MediaAsset, 'taskId' | 'assetId' | 's3Key'>): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: taskPk(asset.taskId),
        SK: taskMediaCleanupSk(asset.assetId),
        entityType: ENTITY.TASK_MEDIA_CLEANUP,
        assetId: asset.assetId,
        s3Key: asset.s3Key,
        createdAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * Retry every durable media cleanup record for one Task. Successful object deletes
 * remove their journals; failures remain visible for the next retry.
 */
export async function retryTaskMediaCleanup(
  taskId: string,
  context: Record<string, unknown> = {},
): Promise<boolean> {
  const journals = await queryAllItems<MediaCleanupJournal>(taskPk(taskId), TASK_MEDIA_CLEANUP_PREFIX);
  let allDeleted = true;
  for (const journal of journals) {
    const deleted = await deleteS3ObjectBestEffort(journal.s3Key, {
      ...context,
      taskId,
      assetId: journal.assetId,
    });
    if (!deleted) {
      allDeleted = false;
      continue;
    }
    await dynamo.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: journal.PK, SK: journal.SK } }),
    );
  }
  return allDeleted;
}

// ── Media-reference cleanup (shared by deleteMediaAsset + deleteTaskStep) ─────────
// These keep the DB free of references to an asset that is being (or has been) removed.
// They issue only DynamoDB writes; the S3 binary is removed separately via
// deleteS3ObjectBestEffort so the S3 boundary stays a single, consistently-logged step.

/** Clear Task.coverImageAssetId iff it currently points at this asset (no-op otherwise). */
export async function clearTaskCoverReference(taskId: string, assetId: string): Promise<void> {
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

/**
 * Clear the single `mediaAssetId` back-reference on whichever TaskStep points at this
 * asset (one-to-one: at most one). Paginated scan because the step SK is order-based.
 */
export async function clearTaskStepMediaReference(taskId: string, assetId: string): Promise<void> {
  const steps = await queryAllItems<TaskStep>(taskPk(taskId), STEP_PREFIX);
  const now = new Date().toISOString();
  for (const step of steps) {
    if (step.mediaAssetId !== assetId) continue;
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: stepSk(step.order) },
        UpdateExpression: 'SET updatedAt = :now REMOVE mediaAssetId',
        ExpressionAttributeValues: { ':now': now },
      }),
    );
  }
}

/**
 * Fully remove one MediaAsset: clear its single back-reference (Task cover OR the owning
 * TaskStep's mediaAssetId — whichever applies; both are safe no-ops when not), delete the
 * metadata row, then best-effort delete the S3 binary. DB-first (references + row before
 * the object) so the API never points at a missing file; the S3 delete is logged for
 * retry on failure. This is the shared cleanup path for deleteMediaAsset, deleteTaskStep,
 * and step-media replacement/removal.
 *
 * Returns whether the S3 binary was deleted — a caller that must not "silently claim all
 * cleanup succeeded" can surface a `false` (the metadata is gone, but a logged, orphaned
 * binary remains for retry/cleanup).
 */
export async function purgeMediaAsset(
  asset: Pick<MediaAsset, 'taskId' | 'assetId' | 's3Key'>,
  context: Record<string, unknown> = {},
): Promise<boolean> {
  const { taskId, assetId, s3Key } = asset;
  // The journal is written before the metadata disappears. If the S3 call fails, a
  // subsequent operation can retry from this durable key rather than losing the binary.
  await journalMediaCleanup(asset);
  await clearTaskCoverReference(taskId, assetId);
  await clearTaskStepMediaReference(taskId, assetId);
  await dynamo.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: mediaSk(assetId) } }),
  );
  const deleted = await deleteS3ObjectBestEffort(s3Key, { ...context, taskId, assetId });
  if (deleted) {
    await dynamo.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: taskPk(taskId), SK: taskMediaCleanupSk(assetId) },
      }),
    );
  }
  return deleted;
}
