import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Building2, LayoutDashboard, ListChecks, LogOut, ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import { useAuth } from '../../../auth/useAuth';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import styles from '../admin.module.css';

interface TabDef {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const TABS: TabDef[] = [
  { to: '/admin', label: 'Overview', icon: <LayoutDashboard size={16} />, end: true },
  { to: '/admin/users', label: 'Users', icon: <Users size={16} /> },
  { to: '/admin/tasks', label: 'Tasks', icon: <ListChecks size={16} /> },
  { to: '/admin/organizations', label: 'Organizations', icon: <Building2 size={16} /> },
  { to: '/admin/danger', label: 'Dangerous Actions', icon: <TriangleAlert size={16} /> },
];

/** Top bar + tab navigation chrome wrapping every admin page. */
export function AdminShell({ children }: { children: ReactNode }) {
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
              <ShieldCheck size={16} />
            </span>
            CanPlan Admin
          </span>
          <span className={styles.topbarSpacer} />
          <div className={styles.account}>
            <Badge tone="info">SystemAdmin</Badge>
            <span className={styles.accountEmail} title={user?.email ?? user?.username}>
              {user?.email ?? user?.username}
            </span>
            <Button size="sm" variant="ghost" icon={<LogOut size={15} />} loading={signingOut} onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </div>
        <nav className={styles.tabs} aria-label="Admin sections">
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
