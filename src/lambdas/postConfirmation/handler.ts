import { AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { cognito, PRIMARY_USER_GROUP } from '../../shared/cognito';

/**
 * Cognito Post Confirmation trigger — automatically adds a self-registered user
 * to the `PrimaryUser` group once they verify their email and confirm sign-up.
 *
 * Cognito requires the trigger to echo the original event back unchanged; the
 * confirmation flow continues regardless of what this handler returns. We never
 * let a group-assignment hiccup block confirmation: AdminAddUserToGroup is
 * idempotent, so a retried trigger on an already-grouped user is harmless, and
 * any other failure is logged rather than thrown.
 */
export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  // Only assign the group on a genuine sign-up confirmation. Other sources —
  // e.g. PostConfirmation_ConfirmForgotPassword — must not touch group membership.
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  const { userPoolId, userName } = event;

  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: userName,
        GroupName: PRIMARY_USER_GROUP,
      }),
    );
  } catch (err) {
    // Safe for retries: adding a user already in the group does not fail, but if
    // Cognito ever surfaces an error here we log it instead of failing the flow.
    console.error(
      `postConfirmation: failed to add "${userName}" to ${PRIMARY_USER_GROUP}`,
      err,
    );
  }

  return event;
};
