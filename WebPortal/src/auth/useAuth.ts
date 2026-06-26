import { useContext } from 'react';
import { AuthContext } from './AuthProvider';
import type { AuthContextValue } from './authTypes';

/** Access the auth context. Throws if used outside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return context;
}
