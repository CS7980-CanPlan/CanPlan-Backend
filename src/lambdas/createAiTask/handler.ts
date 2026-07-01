import { generateTitledSteps } from '../../shared/stepsService';
import { MAX_AI_TASK_STEPS } from '../../shared/steps';
import { UnauthorizedError, ValidationError } from '../../shared/response';
import type { AiTaskGroundingMode, AppSyncEvent, CreateAiTaskInput, GeneratedAiTask } from '../../shared/types';

const GROUNDING_MODES: readonly AiTaskGroundingMode[] = ['GROUNDED_ONLY', 'ALLOW_UNGROUNDED_FALLBACK'];

/**
 * createAiTask — one-shot AI task PREVIEW. The caller gives a single free-text request;
 * the AI (over the Bedrock KB) generates a clean title + ordered steps, which are returned
 * directly to the frontend. Nothing is persisted: no task, steps, category, or media are
 * written, so no categoryId is resolved. The caller saves the preview later via createTask
 * if they keep it.
 *
 * Fallback is controlled by the request, not by role: `GROUNDED_ONLY` (default) throws
 * NotFoundError when no corpus passage clears the relevance threshold, without ever calling
 * the generation model; `ALLOW_UNGROUNDED_FALLBACK` generates ungrounded steps in that case
 * (`grounded: false`, `source: UNGROUNDED_AI`). The caller must be authenticated.
 */
export const handler = async (
  event: AppSyncEvent<{ input: CreateAiTaskInput }>,
): Promise<GeneratedAiTask> => {
  const ownerId = event.identity?.sub?.trim();
  if (!ownerId) throw new UnauthorizedError('Unauthorized: an authenticated user is required');

  const { input } = event.arguments;
  const query = input?.query?.trim();
  if (!query) throw new ValidationError('query is required and cannot be empty');

  const groundingMode = input?.groundingMode ?? 'GROUNDED_ONLY';
  if (!GROUNDING_MODES.includes(groundingMode)) {
    throw new ValidationError(`groundingMode must be one of: ${GROUNDING_MODES.join(', ')}`);
  }

  // stepCount is optional; when supplied it must be an integer 1..20. GraphQL Int already
  // rejects non-integers at the edge, but validate defensively (never silently coerce).
  const stepCount = input?.stepCount;
  if (stepCount != null) {
    if (!Number.isInteger(stepCount) || stepCount < 1 || stepCount > MAX_AI_TASK_STEPS) {
      throw new ValidationError(`stepCount must be an integer from 1 to ${MAX_AI_TASK_STEPS}`);
    }
  }

  // A generation failure throws here; nothing is ever written.
  const { title, steps, grounded, source, usage } = await generateTitledSteps(query, {
    groundingMode,
    stepCount: stepCount ?? undefined,
  });

  // Return the AI title, ordered steps, and their resolved citations. The frontend controls
  // whether the citations field is fetched via GraphQL selection.
  const preview: GeneratedAiTask = {
    title,
    steps: steps.map((s) => ({ text: s.text, citations: s.citations })),
    grounded,
    source,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };

  console.log(
    JSON.stringify({
      event: 'createAiTask',
      ownerId,
      query,
      groundingMode,
      requestedStepCount: stepCount ?? null,
      grounded,
      source,
      stepCount: preview.steps.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }),
  );

  return preview;
};
