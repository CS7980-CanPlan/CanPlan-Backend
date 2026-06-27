import { generateSteps } from '../../shared/stepsService';
import { BEDROCK_MODEL_ID } from '../../shared/bedrock';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, GenerateTaskStepsInput, TaskStepsResponse } from '../../shared/types';

export const handler = async (
  event: AppSyncEvent<{ input: GenerateTaskStepsInput }>,
): Promise<TaskStepsResponse> => {
  const { input } = event.arguments;
  const userId = input?.userId?.trim();
  const query = input?.query?.trim();

  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!query) throw new ValidationError('query is required and cannot be empty');

  const { steps, usage } = await generateSteps(query);

  // Structured CloudWatch log (#18 requirement). userId/context are audit-only.
  console.log(
    JSON.stringify({
      event: 'generateTaskSteps',
      userId,
      query,
      role: input.context?.role,
      organizationId: input.context?.organizationId,
      stepCount: steps.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }),
  );

  return { steps, model: BEDROCK_MODEL_ID, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens };
};
