/** Turn an Amplify/Cognito error into a user-facing message. */
export function authErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name;
  const message = (error as { message?: string })?.message;
  switch (name) {
    case 'NotAuthorizedException':
      return 'Incorrect email or password.';
    case 'UserNotFoundException':
      return 'No account found for that email.';
    case 'UserNotConfirmedException':
      return 'This account is not confirmed yet. Check your email for a verification link.';
    case 'PasswordResetRequiredException':
      return 'A password reset is required. Please reset your password and try again.';
    case 'InvalidPasswordException':
      return message ?? 'That password does not meet the password requirements.';
    case 'LimitExceededException':
      return 'Too many attempts. Please wait a few minutes and try again.';
    default:
      return message ?? 'Something went wrong. Please try again.';
  }
}
