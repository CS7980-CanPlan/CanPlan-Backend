import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardList, FolderTree, ListChecks, RefreshCw } from 'lucide-react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  useUserAssignmentsAll,
  useUserCategories,
  useUserProfile,
  useTasksByOwner,
  supportKeys,
} from '../../api/supportHooks';
import { authErrorMessage } from '../../auth/authError';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { MetricStrip } from '../admin/components/MetricStrip';
import { Panel } from '../admin/components/Panel';
import { formatDate, IdCell, RoleBadge } from '../admin/components/display';
import { SupportedUserCalendar } from './calendar/SupportedUserCalendar';
import { SupportedUserTaskInstances } from './instances/SupportedUserTaskInstances';
import { SupportedUserAssignments } from './tasks/SupportedUserAssignments';
import styles from '../admin/admin.module.css';

/**
 * Detail of one supported primary user at `/support/users/:userId`: delegated profile/task
 * reads plus calendar and schedule management. An effective SupportLink is required for every
 * user-scoped query and mutation.
 */
export default function SupportUserDetailPage() {
  const { userId = '' } = useParams<{ userId: string }>();
  const location = useLocation();
  const queryClient = useQueryClient();

  const profileQuery = useUserProfile(userId);
  const tasksQuery = useTasksByOwner(userId);
  const categoriesQuery = useUserCategories(userId);
  const assignmentsQuery = useUserAssignmentsAll(userId);

  const profile = profileQuery.data;
  const tasks = tasksQuery.data?.items ?? [];
  const categories = categoriesQuery.data?.items ?? [];
  const assignments = assignmentsQuery.data ?? [];

  const displayName = profile?.displayName || profile?.email || userId;
  const anyFetching =
    profileQuery.isFetching ||
    tasksQuery.isFetching ||
    categoriesQuery.isFetching ||
    assignmentsQuery.isFetching;

  useEffect(() => {
    const targetId =
      location.hash === '#calendar'
        ? 'calendar'
        : location.hash === '#task-instances'
          ? 'task-instances'
          : location.hash === '#assignments'
            ? 'assignments'
            : '';
    if (targetId) {
      document.getElementById(targetId)?.scrollIntoView({ block: 'start' });
    }
  }, [location.hash, userId]);

  function refetchAll() {
    profileQuery.refetch();
    tasksQuery.refetch();
    categoriesQuery.refetch();
    assignmentsQuery.refetch();
    queryClient.invalidateQueries({ queryKey: supportKeys.taskInstances(userId) });
    queryClient.invalidateQueries({ queryKey: supportKeys.calendar(userId) });
  }

  return (
    <div>
      <Link to="/support/home" className={styles.backLink}>
        <ArrowLeft size={15} /> Back to people I support
      </Link>

      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{profileQuery.isLoading ? 'User detail' : displayName}</h1>
        <p className={styles.pageSubtitle}>
          A supported user's tasks, categories, and schedule. <IdCell id={userId} />
        </p>
      </div>

      <div className={styles.toolbar}>
        <span className={styles.toolbarMeta}>{anyFetching ? 'Refreshing…' : ' '}</span>
        <div className={styles.pager}>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={refetchAll}
            disabled={anyFetching}
          >
            Refresh details
          </Button>
        </div>
      </div>

      <MetricStrip
        metrics={[
          { label: 'Tasks', value: tasks.length, icon: <ListChecks size={18} /> },
          { label: 'Categories', value: categories.length, icon: <FolderTree size={18} /> },
          { label: 'Assignments', value: assignments.length, icon: <ClipboardList size={18} /> },
        ]}
      />

      <div style={{ height: '1.25rem' }} />

      <Panel title="Profile" description="The user's stored profile record.">
        {profileQuery.isLoading ? (
          <Centered>
            <Spinner label="Loading profile…" />
          </Centered>
        ) : profileQuery.isError ? (
          <Alert variant="error" title="Could not load this profile">
            {authErrorMessage(profileQuery.error)}
          </Alert>
        ) : profile ? (
          <div className={styles.detailGrid}>
            <Detail label="Display name" value={profile.displayName ?? '—'} />
            <Detail label="Email" value={profile.email ?? '—'} />
            <Detail label="Role" value={<RoleBadge role={profile.role} />} />
            <Detail label="Organization" value={profile.organizationId ?? '—'} />
            <Detail label="User id (sub)" value={<IdCell id={profile.userId} />} />
            <Detail label="Created" value={formatDate(profile.createdAt)} />
            <Detail label="Updated" value={formatDate(profile.updatedAt)} />
          </div>
        ) : (
          <Alert variant="warning">This user does not have a profile record yet.</Alert>
        )}
      </Panel>

      <SupportedUserTaskInstances key={userId} userId={userId} displayName={displayName} />

      <SupportedUserCalendar userId={userId} displayName={displayName} />

      <SupportedUserAssignments
        key={userId}
        userId={userId}
        displayName={displayName}
        primaryUserTasks={tasks}
      />

      <Section icon={<ListChecks size={17} />} title="Tasks" count={tasks.length}>
        <ListBody
          query={tasksQuery}
          empty="This user has no tasks yet."
          loadingLabel="Loading tasks…"
        >
          <Table head={['Title', 'Task id', 'Category id', 'Created']}>
            {tasks.map((task) => (
              <tr key={task.taskId}>
                <td className={styles.cellPrimary}>{task.title}</td>
                <td>
                  <IdCell id={task.taskId} />
                </td>
                <td>{task.categoryId ? <IdCell id={task.categoryId} /> : <Dash />}</td>
                <td className={styles.cellMuted}>{formatDate(task.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </ListBody>
      </Section>

      <Section icon={<FolderTree size={17} />} title="Categories" count={categories.length}>
        <ListBody
          query={categoriesQuery}
          empty="This user has no categories."
          loadingLabel="Loading categories…"
        >
          <Table head={['Name', 'Default', 'Category id', 'Created']}>
            {categories.map((cat) => (
              <tr key={cat.categoryId}>
                <td className={styles.cellPrimary}>{cat.name}</td>
                <td>{cat.isDefault ? 'Yes' : <Dash />}</td>
                <td>
                  <IdCell id={cat.categoryId} />
                </td>
                <td className={styles.cellMuted}>{formatDate(cat.createdAt)}</td>
              </tr>
            ))}
          </Table>
        </ListBody>
      </Section>
    </div>
  );
}

/** Shared loading/error/empty wrapper for a delegated list section. */
function ListBody({
  query,
  empty,
  loadingLabel,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; data?: { items: unknown[] } };
  empty: string;
  loadingLabel: string;
  children: ReactNode;
}) {
  if (query.isLoading) {
    return (
      <Centered>
        <Spinner label={loadingLabel} />
      </Centered>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="error" title="Could not load this section">
        {authErrorMessage(query.error)} You can only view this data while you actively support this
        user.
      </Alert>
    );
  }
  if ((query.data?.items.length ?? 0) === 0) {
    return (
      <div className={styles.tableCard}>
        <EmptyState title="Nothing here" description={empty} />
      </div>
    );
  }
  return <>{children}</>;
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.detailItem}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{value}</span>
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <>
      <h2 className={styles.sectionTitle}>
        <span aria-hidden="true">{icon}</span>
        {title}
        <span className={styles.sectionCount}>({count})</span>
      </h2>
      {children}
    </>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className={styles.tableCard}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>{children}</div>;
}

function Dash() {
  return <span className={styles.cellMuted}>—</span>;
}
