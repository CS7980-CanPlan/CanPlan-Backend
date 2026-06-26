import { Link } from 'react-router-dom';
import { ListChecks, ShieldCheck, TriangleAlert, UserCog, Users } from 'lucide-react';
import { useTasksPage, useUsersPage } from '../../api/adminHooks';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';
import { MetricStrip, type Metric } from './components/MetricStrip';
import sharedStyles from './admin.module.css';
import styles from './AdminHomePage.module.css';

const SAMPLE_LIMIT = 50;

/**
 * Operational overview. Shows headline metrics from the first page of users/tasks
 * (clearly labelled as a sample, since there's no count API) and entry tiles into each
 * section.
 */
export default function AdminHomePage() {
  const usersQuery = useUsersPage({ limit: SAMPLE_LIMIT });
  const tasksQuery = useTasksPage({ limit: SAMPLE_LIMIT });

  const users = usersQuery.data?.items ?? [];
  const tasks = tasksQuery.data?.items ?? [];
  const moreUsers = Boolean(usersQuery.data?.nextToken);
  const moreTasks = Boolean(tasksQuery.data?.nextToken);
  const loading = usersQuery.isLoading || tasksQuery.isLoading;
  const failed = usersQuery.isError || tasksQuery.isError;

  const supportPeople = users.filter((u) => u.role === 'SUPPORT_PERSON').length;
  const orgAdmins = users.filter((u) => u.role === 'ORG_ADMIN').length;

  const fmt = (count: number, more: boolean) => (more ? `${count}+` : `${count}`);

  const metrics: Metric[] = [
    { label: `Users (first ${SAMPLE_LIMIT})`, value: fmt(users.length, moreUsers), icon: <Users size={18} /> },
    { label: 'Support people', value: fmt(supportPeople, moreUsers), icon: <UserCog size={18} /> },
    { label: 'Org admins', value: fmt(orgAdmins, moreUsers), icon: <ShieldCheck size={18} /> },
    { label: `Tasks (first ${SAMPLE_LIMIT})`, value: fmt(tasks.length, moreTasks), icon: <ListChecks size={18} /> },
  ];

  return (
    <div>
      <div className={sharedStyles.pageHead}>
        <h1 className={sharedStyles.pageTitle}>Overview</h1>
        <p className={sharedStyles.pageSubtitle}>
          Administration dashboard for the CanPlan backend.
        </p>
      </div>

      {failed ? (
        <Alert variant="error" title="Could not load dashboard data">
          Check your connection and that your account still has SystemAdmin access.
        </Alert>
      ) : loading ? (
        <Spinner label="Loading metrics…" />
      ) : (
        <MetricStrip metrics={metrics} />
      )}

      <div className={sharedStyles.tiles}>
        <Link to="/admin/users" className={sharedStyles.tile}>
          <span className={sharedStyles.tileIcon} aria-hidden="true"><Users size={22} /></span>
          <div>
            <div className={sharedStyles.tileTitle}>Users</div>
            <div className={sharedStyles.tileDesc}>
              Browse users, invite support people / org admins, and change roles.
            </div>
          </div>
        </Link>
        <Link to="/admin/tasks" className={sharedStyles.tile}>
          <span className={sharedStyles.tileIcon} aria-hidden="true"><ListChecks size={22} /></span>
          <div>
            <div className={sharedStyles.tileTitle}>Tasks</div>
            <div className={sharedStyles.tileDesc}>Browse all tasks and remove any task by id.</div>
          </div>
        </Link>
        <Link to="/admin/danger" className={`${sharedStyles.tile} ${sharedStyles.tileDanger}`}>
          <span className={sharedStyles.tileIcon} aria-hidden="true"><TriangleAlert size={22} /></span>
          <div>
            <div className={sharedStyles.tileTitle}>Dangerous Actions</div>
            <div className={sharedStyles.tileDesc}>
              Full user deletion and task deletion, with typed confirmation and audit results.
            </div>
          </div>
        </Link>
      </div>

      <div className={styles.note}>
        <Alert variant="info">
          Metric counts above reflect only the first {SAMPLE_LIMIT} records (there is no total-count
          API). Use the Users and Tasks tabs to page through everything.
        </Alert>
      </div>
    </div>
  );
}
