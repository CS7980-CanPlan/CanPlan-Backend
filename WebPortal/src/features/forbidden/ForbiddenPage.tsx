import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { LogOut, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import styles from './ForbiddenPage.module.css';

/**
 * Shown to an authenticated user who is NOT a SystemAdmin. Offers a sign-out action.
 * Redirects away if the session is gone (→ login) or actually is an admin (→ /admin).
 */
export default function ForbiddenPage() {
  const { loading, user, isSystemAdmin, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (loading) {
    return (
      <div className={styles.page}>
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/" replace />;
  if (isSystemAdmin) return <Navigate to="/admin" replace />;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden="true">
          <ShieldAlert size={32} />
        </span>
        <h1 className={styles.title}>Access restricted</h1>
        <p className={styles.body}>
          You are signed in as <strong>{user.email ?? user.username}</strong>, but this portal
          is limited to <strong>SystemAdmin</strong> accounts. If you believe this is a mistake,
          ask an administrator to grant you the SystemAdmin role, then sign in again.
        </p>
        <Button variant="secondary" icon={<LogOut size={16} />} loading={signingOut} onClick={handleSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
