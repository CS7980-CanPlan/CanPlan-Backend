import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { LifeBuoy, ListChecks, LogOut, Settings, UserRound, Users } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import styles from '../admin/admin.module.css';

interface TabDef {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const TABS: TabDef[] = [
  { to: '/support/home', label: 'People I support', icon: <Users size={16} />, end: true },
  { to: '/support/manage', label: 'Manage people', icon: <Settings size={16} /> },
  { to: '/support/tasks', label: 'Tasks', icon: <ListChecks size={16} /> },
  { to: '/support/profile', label: 'My profile', icon: <UserRound size={16} /> },
];

/** Top bar + tab navigation chrome wrapping every support page (mirrors the admin shell). */
export function SupportShell({ children }: { children: ReactNode }) {
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
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <span className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              <LifeBuoy size={16} />
            </span>
            CanPlan Support
          </span>
          <span className={styles.topbarSpacer} />
          <div className={styles.account}>
            <Badge tone="info">SupportPerson</Badge>
            <span className={styles.accountEmail} title={user?.email ?? user?.username}>
              {user?.email ?? user?.username}
            </span>
            <Button size="sm" variant="ghost" icon={<LogOut size={15} />} loading={signingOut} onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </div>
        <nav className={styles.tabs} aria-label="Support sections">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
            >
              <span aria-hidden="true">{tab.icon}</span>
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
