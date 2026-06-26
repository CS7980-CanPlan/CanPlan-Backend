import { ChevronLeft, ChevronRight, ListChecks, RefreshCw } from 'lucide-react';
import { useTasksPage } from '../../../api/adminHooks';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { formatDate, IdCell } from '../components/display';
import { usePageCursor } from '../usePageCursor';
import styles from '../admin.module.css';

const PAGE_SIZE = 25;

/** Paginated table of all tasks (listAllTasks). */
export function TasksTable() {
  const cursor = usePageCursor();
  const query = useTasksPage({ limit: PAGE_SIZE, nextToken: cursor.cursor });
  const tasks = query.data?.items ?? [];

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
        <Alert variant="error" title="Could not load tasks">
          Please try refreshing. If this persists, confirm your SystemAdmin access.
        </Alert>
      ) : query.isLoading ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading tasks…" />
        </div>
      ) : tasks.length === 0 ? (
        <div className={styles.tableCard}>
          <EmptyState icon={<ListChecks size={32} />} title="No tasks found" description="There are no tasks on this page." />
        </div>
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Task id</th>
                  <th>Owner id</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.taskId}>
                    <td className={styles.cellPrimary}>{task.title}</td>
                    <td><IdCell id={task.taskId} /></td>
                    <td><IdCell id={task.ownerId} /></td>
                    <td className={styles.cellMuted}>{formatDate(task.createdAt)}</td>
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
