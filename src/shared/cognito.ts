import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

// Single shared Cognito Identity Provider client reused across Lambda invocations.
// The user pool lives in the backend region (same as the Lambda's AWS_REGION).
export const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? 'ca-central-1',
});

// Group every verified self-signup user is added to. Mirrors the `PrimaryUser`
// group seeded in infrastructure/lib/constructs/auth.construct.ts.
export const PRIMARY_USER_GROUP = process.env.PRIMARY_USER_GROUP ?? 'PrimaryUser';
