import { assertCanActForUser } from '../../shared/delegation';
import { requireCaller } from '../../shared/authz';
import { persistTask } from '../../shared/task';
import type { AppSyncEvent, CreateTaskInput, Task } from '../../shared/types';

/**
 * createTask — create a reusable task template.
 *
 * The target owner is resolved server-side: an omitted/null/blank `input.userId` means the
 * authenticated caller; a non-self `userId` targets that primary user and is authorized via
 * `assertCanActForUser` (effective SupportPerson delegation — ACTIVE with a current
 * organization/membership snapshot). No client-supplied ownerId is trusted; the task is
 * always written under the resolved target owner. The actual write (category resolution,
 * Task + steps + cover in one transaction) is in persistTask.
 */
export const handler = async (event: AppSyncEvent<{ input: CreateTaskInput }>): Promise<Task> => {
  const { input } = event.arguments;
  const caller = requireCaller(event.identity);
  const targetOwnerId = input?.userId?.trim() || caller;
  // Self is always allowed; a non-self target requires effective SupportPerson delegation.
  await assertCanActForUser(event.identity, targetOwnerId);
  return persistTask(targetOwnerId, input);
};
