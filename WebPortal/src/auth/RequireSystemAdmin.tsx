import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './useAuth';
import { Spinner } from '../components/ui/Spinner';

/**
 * Route guard for the admin area. Renders nothing auth-dependent until the session
 * bootstrap completes (so admin screens never flash before the check). Sends signed-out
 * users to the admin sign-in and authenticated non-admins to the forbidden screen.
 */
export function RequireSystemAdmin({ children }: { children: ReactNode }) {
  const { loading, user, isSystemAdmin } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Spinner label="Checking your session…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/admin" replace />;
  if (!isSystemAdmin) return <Navigate to="/forbidden" replace />;
  return <>{children}</>;
}
