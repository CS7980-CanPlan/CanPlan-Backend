import { type ReactNode } from 'react';
import { ArrowLeft, FolderTree, ClipboardList, ListChecks, RefreshCw, Users as UsersIcon } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useUserData } from '../../../api/adminHooks';
import type { Assignment, Category, SupportLink, Task, UserProfile } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { MetricStrip } from '../components/MetricStrip';
import { Panel } from '../components/Panel';
import { formatDate, IdCell, RoleBadge, StatusBadge } from '../components/display';
import styles from '../admin.module.css';

/**
 * Read-only detail view of a single user: their profile plus everything they own
 * (tasks, categories, assignments, support links), via the SystemAdmin adminGetUserData
 * query. Reached from the Users table "View" action at /admin/users/:userId.
 */
export default function UserDetailPage() {
  const { userId = '' } = useParams<{ userId: string }>();
  const query = useUserData(userId);
  const data = query.data;

  return (
    <div>
      <Link to="/admin/users" className={styles.backLink}>
        <ArrowLeft size={15} /> Back to users
      </Link>

      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>User detail</h1>
        <p className={styles.pageSubtitle}>
          Everything this user owns. <IdCell id={userId} />
        </p>
      </div>

      <div className={styles.toolbar}>
        <span className={styles.toolbarMeta}>
          {query.isFetching && !query.isLoading ? 'Refreshing…' : ' '}
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
        </div>
      </div>

      {query.isError ? (
        <Alert variant="error" title="Could not load this user">
          The user may not exist, or you may lack SystemAdmin access. Try refreshing.
        </Alert>
      ) : query.isLoading || !data ? (
        <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading user data…" />
        </div>
      ) : (
        <UserDetailBody data={data} />
      )}
    </div>
  );
}

function UserDetailBody({
  data,
}: {
  data: {
    profile: UserProfile | null;
    tasks: Task[];
    categories: Category[];
    assignments: Assignment[];
    supportLinks: SupportLink[];
  };
}) {
  const { profile, tasks, categories, assignments, supportLinks } = data;

  return (
    <>
      <MetricStrip
        metrics={[
          { label: 'Tasks', value: tasks.length, icon: <ListChecks size={18} /> },
          { label: 'Categories', value: categories.length, icon: <FolderTree size={18} /> },
          { label: 'Assignments', value: assignments.length, icon: <ClipboardList size={18} /> },
          { label: 'Support links', value: supportLinks.length, icon: <UsersIcon size={18} /> },
        ]}
      />

      <div style={{ height: '1.25rem' }} />

      <Panel title="Profile" description="The user's stored profile record.">
        {profile ? (
          <div className={styles.detailGrid}>
            <Detail label="Display name" value={profile.displayName ?? '—'} />
            <Detail label="Email" value={profile.email ?? '—'} />
            <Detail label="Role" value={<RoleBadge role={profile.role} />} />
            <Detail label="Organization" value={profile.organizationId ?? '—'} />
            <Detail label="User id (sub)" value={<IdCell id={profile.userId} />} />
            <Detail
              label="Default category"
              value={profile.defaultCategoryId ? <IdCell id={profile.defaultCategoryId} /> : '—'}
            />
            <Detail label="Created" value={formatDate(profile.createdAt)} />
            <Detail label="Updated" value={formatDate(profile.updatedAt)} />
          </div>
        ) : (
          <Alert variant="warning">
            This user has no profile row yet (e.g. an invited user who hasn't completed first
            login). Their Cognito account and any data below still exist.
          </Alert>
        )}
      </Panel>

      <Section icon={<ListChecks size={17} />} title="Tasks" count={tasks.length}>
        {tasks.length === 0 ? (
          <EmptyTile label="No tasks owned by this user." />
        ) : (
          <Table head={['Title', 'Task id', 'Category id', 'Created']}>
            {tasks.map((task) => (
              <tr key={task.taskId}>
                <td className={styles.cellPrimary}>{task.title}</td>
                <td><IdCell id={task.taskId} /></td>
                <td>{task.categoryId ? <IdCell id={task.categoryId} /> : <Dash />}</td>
                <td className={styles.cellMuted}>{formatDate(task.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section icon={<FolderTree size={17} />} title="Categories" count={categories.length}>
        {categories.length === 0 ? (
          <EmptyTile label="No categories." />
        ) : (
          <Table head={['Name', 'Default', 'Category id', 'Created']}>
            {categories.map((cat) => (
              <tr key={cat.categoryId}>
                <td className={styles.cellPrimary}>{cat.name}</td>
                <td>{cat.isDefault ? 'Yes' : <Dash />}</td>
                <td><IdCell id={cat.categoryId} /></td>
                <td className={styles.cellMuted}>{formatDate(cat.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section icon={<ClipboardList size={17} />} title="Assignments" count={assignments.length}>
        {assignments.length === 0 ? (
          <EmptyTile label="No assignments." />
        ) : (
          <Table head={['Assignment id', 'Task id', 'Status', 'Due', 'Assigned']}>
            {assignments.map((a) => (
              <tr key={a.assignmentId}>
                <td><IdCell id={a.assignmentId} /></td>
                <td><IdCell id={a.taskId} /></td>
                <td><StatusBadge status={a.status} /></td>
                <td className={styles.cellMuted}>{formatDate(a.dueDate)}</td>
                <td className={styles.cellMuted}>{formatDate(a.assignedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section icon={<UsersIcon size={17} />} title="Support links" count={supportLinks.length}>
        {supportLinks.length === 0 ? (
          <EmptyTile label="No support links involving this user." />
        ) : (
          <Table head={['Supporter id', 'Primary user id', 'Status', 'Created']}>
            {supportLinks.map((link) => (
              <tr key={`${link.supporterId}|${link.primaryUserId}`}>
                <td><IdCell id={link.supporterId} /></td>
                <td><IdCell id={link.primaryUserId} /></td>
                <td><StatusBadge status={link.status} /></td>
                <td className={styles.cellMuted}>{formatDate(link.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
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
            <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyTile({ label }: { label: string }) {
  return (
    <div className={styles.tableCard}>
      <EmptyState title="Nothing here" description={label} />
    </div>
  );
}

function Dash() {
  return <span className={styles.cellMuted}>—</span>;
}
