import { InviteUserPanel } from './InviteUserPanel';
import { SetBaseRolePanel } from './SetBaseRolePanel';
import { SetSystemAdminPanel } from './SetSystemAdminPanel';
import { DeleteUserPanel } from './DeleteUserPanel';
import { UsersTable } from './UsersTable';
import styles from '../admin.module.css';

/** Users section: directory table + Cognito role-management actions. */
export default function UsersPage() {
  return (
    <div>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Users</h1>
        <p className={styles.pageSubtitle}>
          Browse all users and manage their Cognito roles. User ids are the Cognito sub.
        </p>
      </div>

      <UsersTable />

      <div style={{ height: '1.5rem' }} />

      <div className={`${styles.sectionGrid} ${styles.sectionGridTwo}`}>
        <InviteUserPanel variant="SUPPORT_PERSON" />
        <InviteUserPanel variant="ORG_ADMIN" />
        <SetBaseRolePanel />
        <SetSystemAdminPanel />
      </div>

      <div style={{ height: '1.25rem' }} />
      <DeleteUserPanel />
    </div>
  );
}
