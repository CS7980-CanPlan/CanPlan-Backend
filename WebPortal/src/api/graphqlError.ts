import { authErrorMessage } from '../auth/authError';

/**
 * User-facing message for a failed GraphQL call. graphql-request's ClientError stuffs the
 * whole JSON response into `message`; the readable text the backend sent (e.g. "cannot
 * delete task …: 2 active task assignment(s) still reference it") lives in
 * `response.errors[0].message`, so prefer that and fall back to the generic auth formatting.
 */
export function gqlErrorMessage(error: unknown): string {
  const errors = (error as { response?: { errors?: Array<{ message?: string }> } })?.response
    ?.errors;
  const serverMessage = errors?.find((entry) => entry?.message)?.message;
  if (serverMessage) return serverMessage;
  return authErrorMessage(error);
}

/** True when AppSync returned a GraphQL application error instead of an ambiguous transport loss. */
export function hasGraphqlErrorResponse(error: unknown): boolean {
  const errors = (error as { response?: { errors?: unknown[] } })?.response?.errors;
  return Array.isArray(errors) && errors.length > 0;
}
