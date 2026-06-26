import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  confirmSignIn,
  fetchAuthSession,
  getCurrentUser,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import {
  type AuthContextValue,
  type AuthUser,
  type IdTokenPayload,
  type SignInStatus,
  SYSTEM_ADMIN_GROUP,
} from './authTypes';

export const AuthContext = createContext<AuthContextValue | null>(null);

interface SessionState {
  user: AuthUser | null;
  idToken: string | null;
  groups: string[];
}

const EMPTY_SESSION: SessionState = { user: null, idToken: null, groups: [] };

/** Map the Cognito new-password challenge onto our status union, else assert signed-in. */
function statusFromStep(step: string | undefined, isSignedIn: boolean): SignInStatus {
  if (isSignedIn) return 'SIGNED_IN';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'NEW_PASSWORD_REQUIRED';
  throw new Error(
    `Unsupported sign-in step "${step ?? 'unknown'}". This portal only supports password ` +
      'and forced-new-password sign-in.',
  );
}

/**
 * Owns the Cognito session. Tokens are NEVER stored manually — Amplify keeps them and we
 * read them via `fetchAuthSession`. Groups come from the ID token's `cognito:groups` claim,
 * which is the source of truth for SystemAdmin authorization.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const authSession = await fetchAuthSession();
      const idToken = authSession.tokens?.idToken;
      if (!idToken) {
        setSession(EMPTY_SESSION);
        return;
      }
      const payload = idToken.payload as IdTokenPayload;
      const groupsClaim = payload['cognito:groups'];
      const groups = Array.isArray(groupsClaim) ? groupsClaim : [];

      let username = '';
      try {
        username = (await getCurrentUser()).username;
      } catch {
        username = (payload.email as string | undefined) ?? '';
      }

      setSession({
        user: { userId: payload.sub ?? '', username, email: payload.email },
        idToken: idToken.toString(),
        groups,
      });
    } catch {
      // No valid session (signed out / expired) — treat as logged out.
      setSession(EMPTY_SESSION);
    }
  }, []);

  // Bootstrap the session once on mount.
  useEffect(() => {
    let active = true;
    (async () => {
      await refreshSession();
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [refreshSession]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInStatus> => {
      const result = await amplifySignIn({ username: email, password });
      const status = statusFromStep(result.nextStep?.signInStep, result.isSignedIn);
      if (status === 'SIGNED_IN') await refreshSession();
      return status;
    },
    [refreshSession],
  );

  const completeNewPassword = useCallback(
    async (newPassword: string): Promise<SignInStatus> => {
      const result = await confirmSignIn({ challengeResponse: newPassword });
      const status = statusFromStep(result.nextStep?.signInStep, result.isSignedIn);
      if (status === 'SIGNED_IN') await refreshSession();
      return status;
    },
    [refreshSession],
  );

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setSession(EMPTY_SESSION);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session.user,
      idToken: session.idToken,
      groups: session.groups,
      isSystemAdmin: session.groups.includes(SYSTEM_ADMIN_GROUP),
      loading,
      signIn,
      completeNewPassword,
      signOut,
      refreshSession,
    }),
    [session, loading, signIn, completeNewPassword, signOut, refreshSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
