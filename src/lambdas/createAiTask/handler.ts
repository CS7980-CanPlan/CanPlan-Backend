import { generateTitledSteps } from '../../shared/stepsService';
import { getGroups } from '../../shared/auth';
import { SUPPORT_PERSON_GROUP } from '../../shared/cognito';
import { UnauthorizedError, ValidationError } from '../../shared/response';
import type { AppSyncEvent, CreateAiTaskInput, GeneratedAiTask } from '../../shared/types';

/**
 * createAiTask — one-shot AI task PREVIEW. The caller gives a single free-text request;
 * the AI (over the Bedrock KB) generates a clean title + ordered steps, which are returned
 * directly to the frontend. Nothing is persisted: no task, steps, category, or media are
 * written, so no categoryId is resolved. Citations are dropped (end users have cognitive
 * disabilities). The caller saves the preview later via createTask if they keep it.
 *
 * When no corpus passage clears the relevance threshold, only support persons fall back
 * to ungrounded AI generation (`grounded: false`); for everyone else generation throws
 * NotFoundError — a care recipient never receives ungrounded steps.
 */
export const handler = async (
  event: AppSyncEvent<{ input: CreateAiTaskInput }>,
): Promise<GeneratedAiTask> => {
  const ownerId = event.identity?.sub?.trim();
  if (!ownerId) throw new UnauthorizedError('Unauthorized: an authenticated user is required');

  const { input } = event.arguments;
  const query = input?.query?.trim();
  if (!query) throw new ValidationError('query is required and cannot be empty');

  // Server-derived from the caller's Cognito groups — never client-supplied, so it cannot
  // be spoofed. Only support persons may receive an ungrounded fallback.
  const allowFallback = getGroups(event.identity).includes(SUPPORT_PERSON_GROUP);

  // A generation failure throws here; nothing is ever written.
  const { title, steps, grounded, usage } = await generateTitledSteps(query, { allowFallback });

  // Drop citations: return text-only steps under the AI-generated title.
  const preview: GeneratedAiTask = {
    title,
    steps: steps.map((s) => ({ text: s.text })),
    grounded,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };

  console.log(
    JSON.stringify({
      event: 'createAiTask',
      ownerId,
      query,
      grounded,
      stepCount: preview.steps.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }),
  );

  return preview;
};
