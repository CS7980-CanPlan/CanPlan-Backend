// Delegated-access authorization for SupportPerson APIs.
//
// The strict self-ownership model in `authz.ts` answers "is the caller this resource's
// owner?". This module adds the one delegated relationship CanPlan supports: a SupportPerson
// acting on a PRIMARY_USER they have *selected*. Selection is a SupportLink
// (PK = SUPPORTER#<supporterId>, SK = USER#<primaryUserId>); delegated access is granted only
// while that link is ACTIVE *and* both parties currently share an organizationId — so a stale
// link left over from before an org change never keeps granting access.
//
// Two access shapes live here:
//  - `assertCanActForUser` — write/act on a user's schedule (TaskAssignment / TaskInstance).
//    The caller is either that user (self) or their active SupportPerson in the same org.
//  - `assertCanReadTask` — READ-ONLY access to a task template/steps/media. The owner always
//    may; additionally a user who holds an ACTIVE assignment referencing the task may read it
//    (so an assigned primary user can see the SupportPerson's template), but never mutate it.

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireCaller } from './authz';
import { dynamo, TABLE_NAME } from './dynamodb';
import {
  META_SK,
  PROFILE_SK,
  supporterPk,
  TASK_ASSIGNMENT_PREFIX,
  taskPk,
  userLinkSk,
  userPk,
} from './keys';
import { NotFoundError, UnauthorizedError, ValidationError } from './response';
import { isSupportPerson } from './roles';
import type { AppSyncIdentity, SupportLink, Task, UserProfile } from './types';

/** Read a user's #PROFILE row (undefined if the profile doesn't exist). */
export async function loadProfile(userId: string): Promise<UserProfile | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPk(userId), SK: PROFILE_SK } }),
  );
  return result.Item as UserProfile | undefined;
}

/** Read the SupportLink from a supporter to a primary user (undefined if none exists). */
export async function loadSupportLink(
  supporterId: string,
  primaryUserId: string,
): Promise<SupportLink | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: supporterPk(supporterId), SK: userLinkSk(primaryUserId) },
    }),
  );
  return result.Item as SupportLink | undefined;
}

/** Read a task's #META row (undefined if absent). */
async function loadTaskMeta(taskId: string): Promise<Task | undefined> {
  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  return result.Item as Task | undefined;
}

/**
 * Does `userId` hold an ACTIVE TaskAssignment referencing `taskId`? Read-only delegated access
 * to a task's template/steps/media derives from this: an assigned user may read the task the
 * assignment points at even though they don't own it. Scoped to the user's own partition (the
 * caller asks "do *I* have an active assignment for this task?") and follows Query pagination
 * so a user with many assignments is still answered correctly.
 */
export async function hasActiveAssignmentForTask(userId: string, taskId: string): Promise<boolean> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'taskId = :taskId AND active = :true',
        ProjectionExpression: 'PK',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':prefix': TASK_ASSIGNMENT_PREFIX,
          ':taskId': taskId,
          ':true': true,
        },
        ExclusiveStartKey: startKey,
      }),
    );
    if ((result.Items?.length ?? 0) > 0) return true;
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return false;
}

/**
 * Assert the caller may act on `targetUserId`'s schedule (TaskAssignment / TaskInstance) and
 * return the caller's id (Cognito `sub`). Two paths:
 *  - **Self:** the caller is the target user — always allowed (no extra reads).
 *  - **Delegated:** the caller is a SupportPerson holding an ACTIVE SupportLink to the target,
 *    the target is still a PRIMARY_USER, and the target currently shares the caller's
 *    organizationId. A revoked/missing link, a non-SupportPerson caller, a target that is not a
 *    primary user (e.g. a legacy link pointing at a SupportPerson/ORG_ADMIN), a deleted target,
 *    or an org mismatch (either party moved orgs after the link was created) is denied — so a
 *    stale link never grants access.
 */
export async function assertCanActForUser(
  identity: AppSyncIdentity | undefined,
  targetUserId: string,
): Promise<string> {
  const caller = requireCaller(identity);
  const target = targetUserId?.trim();
  if (!target) throw new ValidationError('userId is required and cannot be empty');
  // Self-access never needs a role, a link, or an org — a user always owns their own schedule.
  if (caller === target) return caller;

  // Only a SupportPerson can be delegated access to another user.
  if (!isSupportPerson(identity)) {
    throw new UnauthorizedError(
      'Unauthorized: caller is not allowed to act on this user (no active support link)',
    );
  }

  const link = await loadSupportLink(caller, target);
  if (!link || link.status !== 'ACTIVE') {
    throw new UnauthorizedError(
      'Unauthorized: no active support link to this user (select the user first)',
    );
  }

  const [supporterProfile, targetProfile] = await Promise.all([
    loadProfile(caller),
    loadProfile(target),
  ]);

  // The target must still be a real profile — a link pointing at a deleted user grants nothing.
  if (!targetProfile) {
    throw new UnauthorizedError(
      'Unauthorized: the selected user no longer has a profile (cannot delegate access)',
    );
  }

  // Delegation only ever targets a PRIMARY_USER. A legacy/stale ACTIVE link pointing at a
  // SUPPORT_PERSON or ORG_ADMIN must NOT grant schedule access, regardless of org.
  if (targetProfile.role !== 'PRIMARY_USER') {
    throw new UnauthorizedError(
      'Unauthorized: delegated schedule access is only permitted for a primary user',
    );
  }

  // Both parties must currently share an organization — a link from before an org change
  // does not keep granting access.
  const supporterOrg = supporterProfile?.organizationId?.trim();
  const targetOrg = targetProfile.organizationId?.trim();
  if (!supporterOrg || !targetOrg || supporterOrg !== targetOrg) {
    throw new UnauthorizedError(
      'Unauthorized: support person and user are no longer in the same organization',
    );
  }

  return caller;
}

/**
 * Non-throwing form of `assertCanActForUser`: returns true when the caller may act for
 * `targetUserId` (self or active SupportPerson delegation), false when a delegation check
 * denies it. Any non-authorization error still propagates.
 */
export async function canActForUser(
  identity: AppSyncIdentity | undefined,
  targetUserId: string,
): Promise<boolean> {
  try {
    await assertCanActForUser(identity, targetUserId);
    return true;
  } catch (err) {
    if (err instanceof UnauthorizedError) return false;
    throw err;
  }
}

/**
 * Assert the caller may READ a task's template/steps/media, given an already-loaded task (its
 * `taskId` + `ownerId`). Returns the caller id. Read access is granted to: the owner; a
 * SupportPerson with delegated access to the owner (they can manage it, so they can read it);
 * or a user holding an ACTIVE assignment referencing the task (an assigned primary user may
 * read a SupportPerson's template). The assignment path is read-only — it NEVER grants write
 * access; writes require `assertCanActForUser` on the task's owner.
 */
export async function assertCanReadTask(
  identity: AppSyncIdentity | undefined,
  task: Pick<Task, 'taskId' | 'ownerId'>,
): Promise<string> {
  const caller = requireCaller(identity);
  if (caller === task.ownerId) return caller;
  // A delegated manager (SupportPerson with an active link to the owner) may read.
  if (await canActForUser(identity, task.ownerId)) return caller;
  // An assigned user (active assignment referencing this task) may read — read-only.
  if (await hasActiveAssignmentForTask(caller, task.taskId)) return caller;
  throw new UnauthorizedError(
    'Unauthorized: caller does not own this task, cannot act for its owner, and has no ' +
      'assignment referencing it',
  );
}

/**
 * Load a task's #META and assert the caller may READ it (owner, or holder of an active
 * assignment referencing it). Returns the caller id and the loaded task. Used by media reads
 * (which only carry a taskId) to authorize against the authoritative task owner.
 */
export async function assertCanReadTaskById(
  identity: AppSyncIdentity | undefined,
  taskId: string,
): Promise<{ caller: string; task: Task }> {
  const task = await loadTaskMeta(taskId);
  if (!task) throw new NotFoundError(`task ${taskId} not found`);
  const caller = await assertCanReadTask(identity, task);
  return { caller, task };
}
