/**
 * Typed runtime configuration, read once from Vite's `import.meta.env`.
 *
 * Every value comes from a `VITE_`-prefixed env var (see WebPortal/README.md and
 * `.env.example`). A missing required var is a hard, visible failure in development
 * so misconfiguration surfaces immediately instead of as a confusing Cognito/AppSync
 * error later. The throw also runs in production builds — the app cannot function
 * without these — but the message is tailored for local setup.
 */

export interface AppConfig {
  awsRegion: string;
  userPoolId: string;
  userPoolClientId: string;
  graphqlApiUrl: string;
}

const REQUIRED_VARS = {
  awsRegion: 'VITE_AWS_REGION',
  userPoolId: 'VITE_USER_POOL_ID',
  userPoolClientId: 'VITE_USER_POOL_CLIENT_ID',
  graphqlApiUrl: 'VITE_GRAPHQL_API_URL',
} as const;

function readConfig(): AppConfig {
  const env = import.meta.env;
  const missing: string[] = [];

  const get = (name: string): string => {
    const value = (env as Record<string, string | undefined>)[name];
    if (!value || !value.trim()) {
      missing.push(name);
      return '';
    }
    return value.trim();
  };

  const config: AppConfig = {
    awsRegion: get(REQUIRED_VARS.awsRegion),
    userPoolId: get(REQUIRED_VARS.userPoolId),
    userPoolClientId: get(REQUIRED_VARS.userPoolClientId),
    graphqlApiUrl: get(REQUIRED_VARS.graphqlApiUrl),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}.\n` +
        'Create WebPortal/.env.local (copy .env.example) with the backend deploy ' +
        'outputs (UserPoolId, UserPoolClientId, GraphQLApiUrl, AwsRegion), then restart ' +
        'the dev server.',
    );
  }

  return config;
}

export const config: AppConfig = readConfig();
