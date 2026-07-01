// Shared TaskAssignment helpers used outside the scheduling Lambda.
//
// Task deletion must be blocked while any ACTIVE TaskAssignment still references the task.
// Active assignments carry `activeTaskAssignmentTaskId = taskId` on the sparse
// activeTaskAssignmentTaskIndex; ending/deleting an assignment removes that attribute, so a
// single GSI query proves whether any active assignment remains.

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { ItemKey } from './batch';
import { dynamo, TABLE_NAME } from './dynamodb';
import { ACTIVE_TASK_ASSIGNMENT_TASK_INDEX } from './keys';
import { ValidationError } from './response';
import type { TaskAssignment } from './types';

/** Count active TaskAssignments referencing a task (capped read — existence is all we need). */
export async function countActiveAssignmentsForTask(taskId: string): Promise<number> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: ACTIVE_TASK_ASSIGNMENT_TASK_INDEX,
      KeyConditionExpression: 'activeTaskAssignmentTaskId = :taskId',
      ExpressionAttributeValues: { ':taskId': taskId },
      Select: 'COUNT',
    }),
  );
  return result.Count ?? 0;
}

/**
 * Collect the table keys (PK/SK) of every ACTIVE TaskAssignment referencing a task, following
 * GSI pagination. The index is KEYS_ONLY, so each item carries the table PK/SK. Used by full
 * user deletion to remove assignments that would otherwise be orphaned when the owner's task
 * template is cascaded away.
 */
export async function queryActiveAssignmentKeysForTask(taskId: string): Promise<ItemKey[]> {
  const keys: ItemKey[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: ACTIVE_TASK_ASSIGNMENT_TASK_INDEX,
        KeyConditionExpression: 'activeTaskAssignmentTaskId = :taskId',
        ExpressionAttributeValues: { ':taskId': taskId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (result.Items as ItemKey[]) ?? []) keys.push({ PK: item.PK, SK: item.SK });
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return keys;
}

/** Reject task deletion when any active assignment still references the task. */
export async function assertNoActiveAssignmentsForTask(taskId: string): Promise<void> {
  const count = await countActiveAssignmentsForTask(taskId);
  if (count > 0) {
    throw new ValidationError(
      `cannot delete task ${taskId}: ${count} active task assignment(s) still reference it; ` +
        'end or delete those assignments first',
    );
  }
}

/** Strip internal storage/GSI attributes from a TaskAssignment row before returning it. */
export function presentAssignment(item: Record<string, unknown>): TaskAssignment {
  const out = { ...item };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  delete out.activeTaskAssignmentTaskId;
  return out as unknown as TaskAssignment;
}
