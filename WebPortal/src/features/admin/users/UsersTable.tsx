import { ChevronLeft, ChevronRight, Eye, RefreshCw, Users as UsersIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUsersPage } from '../../../api/adminHooks';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { formatDate, IdCell, RoleBadge } from '../components/display';
import { usePageCursor } from '../usePageCursor';
import styles from '../admin.module.css';

const PAGE_SIZE = 25;

/** Paginated table of all users (listAllUsers). */
export function UsersTable() {
  const cursor = usePageCursor();
  const navigate = useNavigate();
  const query = useUsersPage({ limit: PAGE_SIZE, nextToken: cursor.cursor });
  const users = query.data?.items ?? [];

  return (
    <div>
      <div className={styles.toolbar}>
        <span className={styles.toolbarMeta}>
          Page {cursor.pageIndex + 1}
          {query.isFetching && !query.isLoading ? ' · refreshing…' : ''}
        </span>
        <div className={styles.pager}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<ChevronLeft size={14} />}
            onClick={cursor.goPrev}
            disabled={!cursor.canPrev || query.isFetching}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => cursor.goNext(query.data?.nextToken ?? null)}
            disabled={!query.data?.nextToken || query.isFetching}
          >
            Next
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      {query.isError ? (
        <Alert variant="error" title="Could not load users">
          Please try refreshing. If this persists, confirm your SystemAdmin access.
        </Alert>
      ) : query.isLoading ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading users…" />
        </div>
      ) : users.length === 0 ? (
        <div className={styles.tableCard}>
          <EmptyState
            icon={<UsersIcon size={32} />}
            title="No users found"
            description="There are no users on this page."
          />
        </div>
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Display name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>User id (sub)</th>
                  <th>Org</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.userId}>
                    <td className={styles.cellPrimary}>{user.displayName ?? <span className={styles.cellMuted}>—</span>}</td>
                    <td>{user.email ?? <span className={styles.cellMuted}>—</span>}</td>
                    <td><RoleBadge role={user.role} /></td>
                    <td><IdCell id={user.userId} /></td>
                    <td className={styles.cellMuted}>{user.organizationId ?? '—'}</td>
                    <td className={styles.cellMuted}>{formatDate(user.createdAt)}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Eye size={14} />}
                          onClick={() => navigate(`/admin/users/${encodeURIComponent(user.userId)}`)}
                        >
                          View
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
