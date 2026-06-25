import { persistTask } from '../../shared/task';
import { UnauthorizedError } from '../../shared/response';
import type { AppSyncEvent, CreateTaskInput, Task } from '../../shared/types';

/**
 * createTask — create a reusable task template owned by the authenticated caller.
 * Owner is taken from the Cognito identity (never client-supplied); the actual write
 * (category resolution, Task + steps + cover in one transaction) is in persistTask.
 */
export const handler = async (event: AppSyncEvent<{ input: CreateTaskInput }>): Promise<Task> => {
  const ownerId = event.identity?.sub?.trim();
  if (!ownerId) throw new UnauthorizedError('Unauthorized: an authenticated user is required');
  return persistTask(ownerId, event.arguments.input);
};
