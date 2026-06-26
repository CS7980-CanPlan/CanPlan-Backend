/**
 * Authenticated GraphQL transport. Every admin request carries a FRESH Cognito ID token
 * in the `Authorization` header — we fetch it from the Amplify session per request so a
 * silently-refreshed token is always used (and tokens are never stored manually).
 */
import { fetchAuthSession } from 'aws-amplify/auth';
import { GraphQLClient, type Variables } from 'graphql-request';
import { config } from '../config/env';

/** Resolve the current Cognito ID token, or throw a clear error if the session is gone. */
async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('Your session has expired. Please sign in again.');
  }
  return idToken;
}

/**
 * Run a GraphQL document against the AppSync endpoint with the caller's ID token.
 * Generic over the response and (object) variables shapes for end-to-end typing.
 */
export async function gqlRequest<TResult, TVariables extends Variables = Variables>(
  document: string,
  variables?: TVariables,
): Promise<TResult> {
  const idToken = await getIdToken();
  const client = new GraphQLClient(config.graphqlApiUrl, {
    headers: { Authorization: idToken },
  });
  return client.request<TResult>(document, variables);
}
