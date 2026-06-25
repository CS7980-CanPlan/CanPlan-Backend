import { generateTitledSteps } from '../../shared/stepsService';
import { persistTask } from '../../shared/task';
import { UnauthorizedError, ValidationError } from '../../shared/response';
import type { AppSyncEvent, CreateAiTaskInput, Task } from '../../shared/types';

/**
 * createAiTask — one-shot AI task creation. The caller gives a single free-text request;
 * the AI (over the Bedrock KB) generates a clean title + ordered steps, and the task is
 * created and saved under the authenticated caller. Citations are dropped (end users have
 * cognitive disabilities). Any generation failure throws before any write, so a failed
 * generation never creates a task.
 */
export const handler = async (event: AppSyncEvent<{ input: CreateAiTaskInput }>): Promise<Task> => {
  const ownerId = event.identity?.sub?.trim();
  if (!ownerId) throw new UnauthorizedError('Unauthorized: an authenticated user is required');

  const { input } = event.arguments;
  const query = input?.query?.trim();
  if (!query) throw new ValidationError('query is required and cannot be empty');

  // Generate first; a failure here throws before persistTask is called → no task is written.
  const { title, steps, usage } = await generateTitledSteps(query);

  // Drop citations: persist text-only nested steps under the AI-generated title.
  const task = await persistTask(ownerId, {
    title,
    categoryId: input.categoryId,
    steps: steps.map((s) => ({ text: s.text })),
  });

  console.log(
    JSON.stringify({
      event: 'createAiTask',
      ownerId,
      query,
      taskId: task.taskId,
      stepCount: steps.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }),
  );

  return task;
};
