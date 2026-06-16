import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, PROGRESS_PREFIX, progressSk, userPk } from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, Connection, CreateProgressEventInput, ProgressEvent } from '../../shared/types';

/**
 * Progress domain Lambda — append a progress event and list a user's events.
 * Progress is append-only to support offline sync: every event is a new row keyed
 * by timestamp + a unique eventId, so replays never overwrite earlier events.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<ProgressEvent | Connection<ProgressEvent>> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createProgressEvent':
      return createProgressEvent(args.input as CreateProgressEventInput);
    case 'listProgressEventsForUser':
      return listProgressEventsForUser(
        args.userId as string,
        args.assignmentId as string | undefined,
        pageArgs(args),
      );
    default:
      throw new Error(`progress handler: unsupported field "${event.info?.fieldName}"`);
  }
};

async function createProgressEvent(input: CreateProgressEventInput): Promise<ProgressEvent> {
  const userId = input?.userId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!input?.eventType) throw new ValidationError('eventType is required');

  const now = new Date().toISOString();
  const eventId = randomUUID();
  // Client-supplied timestamp (when it happened offline) wins; fall back to now.
  const timestamp = input.timestamp?.trim() || now;

  const progressEvent: ProgressEvent = {
    eventId,
    assignmentId: input.assignmentId?.trim(),
    taskId: input.taskId?.trim(),
    userId,
    eventType: input.eventType,
    timestamp,
    source: input.source?.trim(),
    metadata: input.metadata,
    createdAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(userId),
        SK: progressSk(timestamp, eventId),
        entityType: ENTITY.PROGRESS_EVENT,
        ...progressEvent,
      },
      // Append-only: refuse to overwrite an existing event row.
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return progressEvent;
}

async function listProgressEventsForUser(
  userId: string,
  assignmentId: string | undefined,
  page: PageArgs,
): Promise<Connection<ProgressEvent>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');

  const values: Record<string, unknown> = { ':pk': userPk(userId), ':prefix': PROGRESS_PREFIX };
  if (assignmentId) values[':assignmentId'] = assignmentId;

  return queryPage<ProgressEvent>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      // Optionally narrow to one assignment's events.
      ...(assignmentId ? { FilterExpression: 'assignmentId = :assignmentId' } : {}),
      ExpressionAttributeValues: values,
    },
    page,
  );
}
