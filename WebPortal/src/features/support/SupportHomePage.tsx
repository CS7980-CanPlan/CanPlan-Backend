import { useState } from 'react';
import { LifeBuoy, LogOut } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import styles from './SupportHomePage.module.css';

/**
 * Placeholder home for signed-in support persons at `/support/home`. The support
 * workflows are not built yet — this confirms the session and offers sign-out so the
 * auth flow is complete end to end.
 */
export default function SupportHomePage() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

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
          <LifeBuoy size={28} />
        </span>
        <Badge tone="info">SupportPerson</Badge>
        <h1 className={styles.title}>Welcome to the support portal</h1>
        <p className={styles.body}>
          You are signed in as <strong>{user?.email ?? user?.username}</strong>. Support
          features are coming soon.
        </p>
        <Button variant="secondary" icon={<LogOut size={16} />} loading={signingOut} onClick={handleSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
