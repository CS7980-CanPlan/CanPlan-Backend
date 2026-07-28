import { generateSteps } from '../../shared/stepsService';
import { BEDROCK_MODEL_ID } from '../../shared/bedrock';
import { requireCaller } from '../../shared/authz';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, GenerateTaskStepsInput, TaskStepsResponse } from '../../shared/types';

export const handler = async (
  event: AppSyncEvent<{ input: GenerateTaskStepsInput }>,
): Promise<TaskStepsResponse> => {
  const { input } = event.arguments;
  const userId = requireCaller(event.identity);
  const query = input?.query?.trim();

  if (!query) throw new ValidationError('query is required and cannot be empty');

  const { steps, usage } = await generateSteps(query);

  // Structured CloudWatch log (#18 requirement). The audit userId is identity-derived; the
  // legacy client input is ignored so callers cannot spoof another user in the log. Context is
  // client-supplied diagnostic metadata only and is never used for authorization.
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
