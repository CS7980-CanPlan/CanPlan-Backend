import { ChevronLeft, ChevronRight, RefreshCw, UserMinus, Users as UsersIcon } from 'lucide-react';
import { useAdminSetUserOrganization, useOrganizationUsers } from '../../../api/adminHooks';
import type { Organization } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { IdCell, RoleBadge } from '../components/display';
import { usePageCursor } from '../usePageCursor';
import styles from '../admin.module.css';

const PAGE_SIZE = 25;

/**
 * Paginated roster of one organization's members (adminListOrganizationUsers). Each row can
 * remove the member (adminSetUserOrganization with organizationId: null). Mount with a `key` of
 * the org id so switching orgs resets the page cursor.
 */
export function OrganizationMembersTable({ org }: { org: Organization }) {
  const cursor = usePageCursor();
  const query = useOrganizationUsers(org.organizationId, {
    limit: PAGE_SIZE,
    nextToken: cursor.cursor,
  });
  const removeMutation = useAdminSetUserOrganization();
  const members = query.data?.items ?? [];

  return (
    <div>
      <div className={styles.toolbar}>
        <span className={styles.toolbarMeta}>
          Members · page {cursor.pageIndex + 1}
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

      {removeMutation.isError && (
        <div style={{ marginBottom: '0.75rem' }}>
          <Alert variant="error" title="Could not remove member">
            Please try again.
          </Alert>
        </div>
      )}

      {query.isError ? (
        <Alert variant="error" title="Could not load members">
          Please try refreshing.
        </Alert>
      ) : query.isLoading ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading members…" />
        </div>
      ) : members.length === 0 ? (
        <div className={styles.tableCard}>
          <EmptyState
            icon={<UsersIcon size={32} />}
            title="No members"
            description="Add a user with the form below."
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
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td className={styles.cellPrimary}>
                      {member.displayName ?? <span className={styles.cellMuted}>—</span>}
                    </td>
                    <td>{member.email ?? <span className={styles.cellMuted}>—</span>}</td>
                    <td><RoleBadge role={member.role} /></td>
                    <td><IdCell id={member.userId} /></td>
                    <td>
                      <div className={styles.rowActions}>
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<UserMinus size={14} />}
                          loading={
                            removeMutation.isPending &&
                            removeMutation.variables?.userId === member.userId
                          }
                          disabled={removeMutation.isPending}
                          onClick={() =>
                            removeMutation.mutate({ userId: member.userId, organizationId: null })
                          }
                        >
                          Remove
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
