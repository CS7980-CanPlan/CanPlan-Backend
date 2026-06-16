import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireGroup } from '../../shared/auth';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, ENTITY_TYPE_INDEX, type EntityType } from '../../shared/keys';
import { decodeNextToken, encodeNextToken } from '../../shared/pagination';
import type { AppSyncEvent, Connection, Task, UserProfile } from '../../shared/types';

/** Only SystemAdmins may call the admin/debug listing APIs. */
const ADMIN_GROUP = 'SystemAdmin';

interface ListArgs {
  limit?: number;
  nextToken?: string;
}

/**
 * Admin domain Lambda — SystemAdmin-only "list all of one entity type" APIs, backed
 * by entityTypeIndex (no Scan). Adding more list-all APIs later (assignments, media)
 * is just another case + schema field. Routed by the resolved GraphQL field.
 */
export const handler = async (
  event: AppSyncEvent<ListArgs>,
): Promise<Connection<UserProfile> | Connection<Task>> => {
  // Every admin field requires the SystemAdmin Cognito group — check before routing
  // so we never leak which fields exist to a non-admin (defense-in-depth; AppSync
  // also gates these fields via an @aws_cognito_user_pools directive).
  requireGroup(event.identity, ADMIN_GROUP);

  const { limit, nextToken } = event.arguments;
  switch (event.info?.fieldName) {
    case 'listAllUsers':
      return listByEntityType<UserProfile>(ENTITY.USER_PROFILE, limit, nextToken);
    case 'listAllTasks':
      return listByEntityType<Task>(ENTITY.TASK, limit, nextToken);
    default:
      throw new Error(`admin handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/** Query entityTypeIndex for one entityType, newest-first, with opaque-token pagination. */
async function listByEntityType<T>(
  entityType: EntityType,
  limit?: number,
  nextToken?: string,
): Promise<Connection<T>> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: ENTITY_TYPE_INDEX,
      KeyConditionExpression: 'entityType = :et',
      ExpressionAttributeValues: { ':et': entityType },
      ScanIndexForward: false, // newest createdAt first
      Limit: typeof limit === 'number' && limit > 0 ? limit : undefined,
      ExclusiveStartKey: decodeNextToken(nextToken),
    }),
  );

  return {
    items: (result.Items as T[]) ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey),
  };
}
