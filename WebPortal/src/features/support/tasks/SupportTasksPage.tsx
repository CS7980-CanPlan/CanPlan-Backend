import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, ListChecks, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useAuth } from '../../../auth/useAuth';
import { useDeleteTask, useOwnedTasks, useUserCategories } from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import type { Task } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { Panel } from '../../admin/components/Panel';
import {
  ConfirmDangerAction,
  confirmationMatches,
} from '../../admin/components/ConfirmDangerAction';
import { formatDate } from '../../admin/components/display';
import adminStyles from '../../admin/admin.module.css';
import styles from './tasks.module.css';

/**
 * `/support/tasks` — the SupportPerson's OWN task templates (`listTasksByOwner` on the
 * caller's Cognito sub). Templates owned by supported primary users are intentionally not
 * listed here — those are visible read-only on each user's detail page.
 */
export default function SupportTasksPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const ownerId = user?.userId;

  const tasksQuery = useOwnedTasks(ownerId);
  const categoriesQuery = useUserCategories(ownerId);
  const deleteMutation = useDeleteTask(ownerId);

  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const tasks = useMemo(
    () => (tasksQuery.data?.pages ?? []).flatMap((page) => page.items),
    [tasksQuery.data],
  );

  /** categoryId → display name (the default category renders as "No Category"). */
  const categoryNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const category of categoriesQuery.data?.items ?? []) {
      names.set(category.categoryId, category.name);
    }
    return names;
  }, [categoriesQuery.data]);

  function startDelete(task: Task) {
    deleteMutation.reset();
    setConfirmText('');
    setPendingDelete(task);
  }

  function handleDeleteSubmit(event: FormEvent) {
    event.preventDefault();
    if (!pendingDelete || !confirmationMatches('delete', confirmText)) return;
    deleteMutation.mutate(pendingDelete.taskId, {
      onSuccess: () => {
        setPendingDelete(null);
        setConfirmText('');
      },
    });
  }

  return (
    <div>
      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>My task templates</h1>
        <p className={adminStyles.pageSubtitle}>
          Reusable tasks you own. Assign one to a person you support to schedule it for them —
          the template stays yours and is never copied into their account.
        </p>
      </div>

      <div className={adminStyles.toolbar}>
        <span className={adminStyles.toolbarMeta}>
          {tasksQuery.isSuccess ? `${tasks.length} template(s) loaded` : ' '}
          {tasksQuery.isFetching && !tasksQuery.isLoading ? ' · refreshing…' : ''}
        </span>
        <div className={adminStyles.pager}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => tasksQuery.refetch()}
            disabled={tasksQuery.isFetching}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => navigate('/support/tasks/new')}
          >
            New task
          </Button>
        </div>
      </div>

      {pendingDelete && (
        <div style={{ marginBottom: '1rem' }}>
          <Panel
            title={`Delete "${pendingDelete.title}"`}
            description="Permanently removes this template and all of its steps. A task with active assignments cannot be deleted — end or stop those assignments first."
            icon={<Trash2 size={16} />}
          >
            <form className={adminStyles.panelForm} onSubmit={handleDeleteSubmit}>
              <ConfirmDangerAction
                expected="delete"
                value={confirmText}
                onChange={setConfirmText}
                targetLabel="word"
              />
              {deleteMutation.isError && (
                <Alert variant="error" title="Could not delete this task">
                  {gqlErrorMessage(deleteMutation.error)}
                </Alert>
              )}
              <div className={adminStyles.formActions}>
                <Button
                  type="submit"
                  variant="danger"
                  icon={<Trash2 size={15} />}
                  loading={deleteMutation.isPending}
                  disabled={!confirmationMatches('delete', confirmText)}
                >
                  Permanently delete
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPendingDelete(null)}
                  disabled={deleteMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Panel>
        </div>
      )}

      {tasksQuery.isError ? (
        <Alert variant="error" title="Could not load your task templates">
          {gqlErrorMessage(tasksQuery.error)}
        </Alert>
      ) : tasksQuery.isLoading ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading your task templates…" />
        </div>
      ) : tasks.length === 0 ? (
        <div className={adminStyles.tableCard}>
          <EmptyState
            icon={<ListChecks size={32} />}
            title="No task templates yet"
            description="Create your first reusable task, then assign it to the people you support."
          />
          <div style={{ display: 'grid', placeItems: 'center', paddingBottom: '1.5rem' }}>
            <Button icon={<Plus size={15} />} onClick={() => navigate('/support/tasks/new')}>
              Create a task
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.taskList}>
            {tasks.map((task) => (
              <article key={task.taskId} className={styles.taskCard}>
                <div className={styles.taskCardHead}>
                  <Link to={`/support/tasks/${encodeURIComponent(task.taskId)}`} className={styles.taskCardTitle}>
                    {task.title}
                  </Link>
                  <Badge tone="neutral">
                    {task.categoryId
                      ? (categoryNames.get(task.categoryId) ?? 'Category')
                      : 'No Category'}
                  </Badge>
                </div>
                {task.description && <p className={styles.taskCardDesc}>{task.description}</p>}
                <div className={styles.taskCardMeta}>
                  {typeof task.order === 'number' && <span>Order {task.order}</span>}
                  <span>Updated {formatDate(task.updatedAt ?? task.createdAt)}</span>
                </div>
                <div className={styles.taskCardActions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate(`/support/tasks/${encodeURIComponent(task.taskId)}`)}
                  >
                    Open / edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<CalendarClock size={14} />}
                    onClick={() =>
                      navigate(`/support/tasks/${encodeURIComponent(task.taskId)}#assignments`)
                    }
                  >
                    Assign
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} />}
                    onClick={() => startDelete(task)}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>

          {tasksQuery.hasNextPage && (
            <div style={{ display: 'grid', placeItems: 'center', marginTop: '1rem' }}>
              <Button
                variant="secondary"
                onClick={() => tasksQuery.fetchNextPage()}
                loading={tasksQuery.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
