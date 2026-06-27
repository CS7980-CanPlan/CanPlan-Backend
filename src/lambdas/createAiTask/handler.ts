import { generateTitledSteps } from '../../shared/stepsService';
import { UnauthorizedError, ValidationError } from '../../shared/response';
import type { AppSyncEvent, CreateAiTaskInput, GeneratedAiTask } from '../../shared/types';

/**
 * createAiTask — one-shot AI task PREVIEW. The caller gives a single free-text request;
 * the AI (over the Bedrock KB) generates a clean title + ordered steps, which are returned
 * directly to the frontend. Nothing is persisted: no task, steps, category, or media are
 * written, so no categoryId is resolved. Citations are dropped (end users have cognitive
 * disabilities). The caller saves the preview later via createTask if they keep it.
 */
export const handler = async (
  event: AppSyncEvent<{ input: CreateAiTaskInput }>,
): Promise<GeneratedAiTask> => {
  const ownerId = event.identity?.sub?.trim();
  if (!ownerId) throw new UnauthorizedError('Unauthorized: an authenticated user is required');

  const { input } = event.arguments;
  const query = input?.query?.trim();
  if (!query) throw new ValidationError('query is required and cannot be empty');

  // A generation failure throws here; nothing is ever written.
  const { title, steps, usage } = await generateTitledSteps(query);

  // Drop citations: return text-only steps under the AI-generated title.
  const preview: GeneratedAiTask = {
    title,
    steps: steps.map((s) => ({ text: s.text })),
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };

  console.log(
    JSON.stringify({
      event: 'createAiTask',
      ownerId,
      query,
      stepCount: preview.steps.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }),
  );

  return preview;
};
