import { useNavigate } from 'react-router-dom';
import { RefreshCw, Settings, Users as UsersIcon } from 'lucide-react';
import { useMySupportList } from '../../api/supportHooks';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { SupportedUserCard } from './userCards';
import adminStyles from '../admin/admin.module.css';
import styles from './support.module.css';

/**
 * Support home at `/support/home`. A read-only overview of the primary users this support
 * person currently supports (their ACTIVE SupportLinks); each opens a detail page. Adding and
 * removing people lives on the separate Manage page (`/support/manage`).
 */
export default function SupportHomePage() {
  const navigate = useNavigate();
  const supportList = useMySupportList();

  const activeLinks = (supportList.data?.items ?? []).filter((link) => link.status === 'ACTIVE');
  const openUser = (userId: string) => navigate(`/support/users/${encodeURIComponent(userId)}`);

  return (
    <div>
      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>People I support</h1>
        <p className={adminStyles.pageSubtitle}>
          The primary users you support. Open one to see their tasks, categories, and schedule.
        </p>
      </div>

      <div className={adminStyles.toolbar}>
        <span className={adminStyles.toolbarMeta}>
          {supportList.isFetching && !supportList.isLoading ? 'Refreshing…' : ' '}
        </span>
        <div className={adminStyles.pager}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => supportList.refetch()}
            disabled={supportList.isFetching}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Settings size={14} />}
            onClick={() => navigate('/support/manage')}
          >
            Manage people
          </Button>
        </div>
      </div>

      {supportList.isError ? (
        <Alert variant="error" title="Could not load your support list">
          Please try refreshing. If this persists, confirm you are signed in as a support person.
        </Alert>
      ) : supportList.isLoading ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading your support list…" />
        </div>
      ) : activeLinks.length === 0 ? (
        <div className={adminStyles.tableCard}>
          <EmptyState
            icon={<UsersIcon size={32} />}
            title="You're not supporting anyone yet"
            description="Use “Manage people” to add primary users from your organization."
          />
        </div>
      ) : (
        <div className={styles.userList}>
          {activeLinks.map((link) => (
            <SupportedUserCard key={link.primaryUserId} userId={link.primaryUserId} onOpen={openUser} />
          ))}
        </div>
      )}
    </div>
  );
}
