// Cover-image + S3 object helpers shared by the createTask, tasks, and media Lambdas.
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
import { NotFoundError, ValidationError } from './response';
import { MEDIA_BUCKET, s3 } from './s3';
import type { MediaAsset } from './types';

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
