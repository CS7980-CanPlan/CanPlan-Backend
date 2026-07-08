import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Home, LogOut, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import styles from './ForbiddenPage.module.css';

/**
 * Shown to an authenticated user whose account is not in the group required by the area
 * they tried to open (e.g. a support person opening the admin console, or vice versa).
 * Offers a way back to the portal home and a sign-out action.
 */
export default function ForbiddenPage() {
  const { loading, user, signOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  if (loading) {
    return (
      <div className={styles.page}>
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/" replace />;

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
          You are signed in as <strong>{user.email ?? user.username}</strong>, but your account
          does not have access to this area. If you believe this is a mistake, ask an
          administrator to grant you the right role, then sign in again.
        </p>
        <div className={styles.actions}>
          <Button variant="secondary" icon={<Home size={16} />} onClick={() => navigate('/')}>
            Back to portal home
          </Button>
          <Button variant="ghost" icon={<LogOut size={16} />} loading={signingOut} onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
