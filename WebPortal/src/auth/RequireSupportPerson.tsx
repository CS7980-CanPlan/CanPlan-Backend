import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './useAuth';
import { Spinner } from '../components/ui/Spinner';

/**
 * Route guard for the support area. Renders nothing auth-dependent until the session
 * bootstrap completes (so support screens never flash before the check). Sends signed-out
 * users to the support sign-in and authenticated non-support users to the forbidden screen.
 */
export function RequireSupportPerson({ children }: { children: ReactNode }) {
  const { loading, user, isSupportPerson } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Spinner label="Checking your session…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/support" replace />;
  if (!isSupportPerson) return <Navigate to="/forbidden" replace />;
  return <>{children}</>;
}
