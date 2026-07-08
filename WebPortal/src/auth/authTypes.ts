/** Shared auth types + the Cognito group names (must match the backend ROLE_GROUPS). */

export const SYSTEM_ADMIN_GROUP = 'SystemAdmin';
export const SUPPORT_PERSON_GROUP = 'SupportPerson';

/** The minimal identity we surface from the Cognito ID token. */
export interface AuthUser {
  /** Cognito `sub` — the app-level userId used by admin APIs. */
  userId: string;
  username: string;
  email?: string;
}

/**
 * The claims we read off a decoded Cognito ID token. Indexed by string because a JWT
 * payload is an open bag of claims — this is the one place `unknown`/loose typing is
 * acceptable (the JWT boundary).
 */
export interface IdTokenPayload {
  sub?: string;
  email?: string;
  'cognito:groups'?: string[];
  [claim: string]: unknown;
}

/** Outcome of a sign-in / new-password step. */
export type SignInStatus = 'SIGNED_IN' | 'NEW_PASSWORD_REQUIRED';

export interface AuthContextValue {
  /** Current authenticated user, or null when signed out. */
  user: AuthUser | null;
  /** Current Cognito ID token (JWT string), or null. For display/debug; API calls fetch fresh. */
  idToken: string | null;
  /** Cognito groups from the ID token. */
  groups: string[];
  /** True when the user belongs to the SystemAdmin group. */
  isSystemAdmin: boolean;
  /** True when the user belongs to the SupportPerson group. */
  isSupportPerson: boolean;
  /** True during the initial session bootstrap — gate all auth-dependent UI on this. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<SignInStatus>;
  /** Complete the Cognito FORCE_CHANGE_PASSWORD / new-password-required challenge. */
  completeNewPassword: (newPassword: string) => Promise<SignInStatus>;
  signOut: () => Promise<void>;
  /** Re-read the Cognito session (tokens + groups) from the Amplify-managed store. */
  refreshSession: () => Promise<void>;
}
