/**
 * Amplify Auth bootstrap. Configures the Cognito User Pool from typed env config so
 * the rest of the app can call `aws-amplify/auth` helpers. Call `configureAmplify()`
 * once, before rendering. Region is inferred by Amplify from the User Pool id.
 */
import { Amplify } from 'aws-amplify';
import { config } from '../config/env';

let configured = false;

export function configureAmplify(): void {
  if (configured) return;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });
  configured = true;
}
