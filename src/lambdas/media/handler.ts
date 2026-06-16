import { randomUUID } from 'crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, MEDIA_PREFIX, mediaSk, taskPk } from '../../shared/keys';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, CreateMediaAssetInput, MediaAsset } from '../../shared/types';

/**
 * Media domain Lambda — record metadata for a media asset (IMAGE / AUDIO / VIDEO)
 * and list a task's media. The binary stays in S3; DynamoDB only stores the s3Key
 * and descriptive metadata. Routed by GraphQL field.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<MediaAsset | MediaAsset[]> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createMediaAsset':
      return createMediaAsset(args.input as CreateMediaAssetInput);
    case 'listMediaForTask':
      return listMediaForTask(args.taskId as string);
    default:
      throw new Error(`media handler: unsupported field "${event.info?.fieldName}"`);
  }
};

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

async function listMediaForTask(taskId: string): Promise<MediaAsset[]> {
  if (!taskId?.trim()) throw new ValidationError('taskId is required');
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': taskPk(taskId), ':prefix': MEDIA_PREFIX },
    }),
  );
  return (result.Items as MediaAsset[]) ?? [];
}
