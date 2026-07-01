import { Building2, ChevronLeft, ChevronRight, RefreshCw, Settings2 } from 'lucide-react';
import { useOrganizationsPage } from '../../../api/adminHooks';
import type { Organization } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { formatDate, IdCell } from '../components/display';
import { usePageCursor } from '../usePageCursor';
import styles from '../admin.module.css';

const PAGE_SIZE = 25;

/** Paginated table of all organizations (listAllOrganizations). "Manage" selects an org. */
export function OrganizationsTable({
  selectedId,
  onManage,
}: {
  selectedId: string | undefined;
  onManage: (org: Organization) => void;
}) {
  const cursor = usePageCursor();
  const query = useOrganizationsPage({ limit: PAGE_SIZE, nextToken: cursor.cursor });
  const orgs = query.data?.items ?? [];

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
        <Alert variant="error" title="Could not load organizations">
          Please try refreshing. If this persists, confirm your SystemAdmin access.
        </Alert>
      ) : query.isLoading ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading organizations…" />
        </div>
      ) : orgs.length === 0 ? (
        <div className={styles.tableCard}>
          <EmptyState
            icon={<Building2 size={32} />}
            title="No organizations yet"
            description="Create one with the form below."
          />
        </div>
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Organization id</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => {
                  const selected = org.organizationId === selectedId;
                  return (
                    <tr key={org.organizationId} aria-current={selected || undefined}>
                      <td className={styles.cellPrimary}>{org.name}</td>
                      <td><IdCell id={org.organizationId} /></td>
                      <td className={styles.cellMuted}>{formatDate(org.createdAt)}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <Button
                            size="sm"
                            variant={selected ? 'primary' : 'secondary'}
                            icon={<Settings2 size={14} />}
                            onClick={() => onManage(org)}
                          >
                            {selected ? 'Managing' : 'Manage'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
