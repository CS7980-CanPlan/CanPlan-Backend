import { requireGroup } from '../../shared/auth';
import { TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, ENTITY_TYPE_INDEX, type EntityType } from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import type { AppSyncEvent, Connection, Task, UserProfile } from '../../shared/types';

/** Only SystemAdmins may call the admin/debug listing APIs. */
const ADMIN_GROUP = 'SystemAdmin';

/**
 * Admin domain Lambda — SystemAdmin-only "list all of one entity type" APIs, backed
 * by entityTypeIndex (no Scan). Adding more list-all APIs later (assignments, media)
 * is just another case + schema field. Routed by the resolved GraphQL field.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Connection<UserProfile> | Connection<Task>> => {
  // Every admin field requires the SystemAdmin Cognito group — check before routing
  // so we never leak which fields exist to a non-admin (defense-in-depth; AppSync
  // also gates these fields via an @aws_cognito_user_pools directive).
  requireGroup(event.identity, ADMIN_GROUP);

  const page = pageArgs(event.arguments);
  switch (event.info?.fieldName) {
    case 'listAllUsers':
      return listByEntityType<UserProfile>(ENTITY.USER_PROFILE, page);
    case 'listAllTasks':
      return listByEntityType<Task>(ENTITY.TASK, page);
    default:
      throw new Error(`admin handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/** Query entityTypeIndex for one entityType, newest-first, with opaque-token pagination. */
function listByEntityType<T>(entityType: EntityType, page: PageArgs): Promise<Connection<T>> {
  return queryPage<T>(
    {
      TableName: TABLE_NAME,
      IndexName: ENTITY_TYPE_INDEX,
      KeyConditionExpression: 'entityType = :et',
      ExpressionAttributeValues: { ':et': entityType },
      ScanIndexForward: false, // newest createdAt first
    },
    page,
  );
}
