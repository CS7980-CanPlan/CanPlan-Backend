import { randomUUID } from 'crypto';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ASSIGN_PREFIX, assignSk, ENTITY, userPk } from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import { ValidationError } from '../../shared/response';
import type {
  AppSyncEvent,
  Assignment,
  Connection,
  CreateAssignmentInput,
  UpdateAssignmentStatusInput,
} from '../../shared/types';

/**
 * Assignments domain Lambda — assign a task template to a user, update an
 * assignment's status, and list a user's assignments. Routed by GraphQL field.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Assignment | Connection<Assignment>> => {
  const { arguments: args } = event;
  switch (event.info?.fieldName) {
    case 'createAssignment':
      return createAssignment(args.input as CreateAssignmentInput);
    case 'updateAssignmentStatus':
      return updateAssignmentStatus(args.input as UpdateAssignmentStatusInput);
    case 'listAssignmentsForUser':
      return listAssignmentsForUser(args.userId as string, pageArgs(args));
    default:
      throw new Error(`assignments handler: unsupported field "${event.info?.fieldName}"`);
  }
};

async function createAssignment(input: CreateAssignmentInput): Promise<Assignment> {
  const taskId = input?.taskId?.trim();
  const userId = input?.userId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!userId) throw new ValidationError('userId is required and cannot be empty');

  // assignmentId is globally unique so the SK is ASSIGN#<assignmentId>, never
  // ASSIGN#<taskId> — a user can hold many assignments of the same task template.
  const assignmentId = randomUUID();
  const now = new Date().toISOString();
  const assignment: Assignment = {
    assignmentId,
    taskId,
    userId,
    assignedBy: input.assignedBy?.trim(),
    dueDate: input.dueDate,
    recurrence: input.recurrence,
    scheduleRule: input.scheduleRule,
    active: input.active ?? true,
    status: input.status ?? 'ACTIVE',
    assignedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(userId),
        SK: assignSk(assignmentId),
        entityType: ENTITY.ASSIGNMENT,
        ...assignment,
      },
      // Never clobber an existing assignment row (defensive — assignmentId is unique).
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return assignment;
}

async function updateAssignmentStatus(input: UpdateAssignmentStatusInput): Promise<Assignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  if (!input?.status) throw new ValidationError('status is required');

  const now = new Date().toISOString();
  // `status` is a DynamoDB reserved word, so alias every updated name.
  const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':status': input.status, ':updatedAt': now };
  const sets = ['#status = :status', '#updatedAt = :updatedAt'];
  if (input.active !== undefined && input.active !== null) {
    names['#active'] = 'active';
    values[':active'] = input.active;
    sets.push('#active = :active');
  }

  const result = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: assignSk(assignmentId) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      // Fail loudly instead of creating a stub row if the assignment doesn't exist.
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes as Assignment;
}

async function listAssignmentsForUser(
  userId: string,
  page: PageArgs,
): Promise<Connection<Assignment>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  return queryPage<Assignment>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': ASSIGN_PREFIX },
    },
    page,
  );
}
