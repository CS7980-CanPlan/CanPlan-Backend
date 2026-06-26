import { DeleteTaskPanel } from './DeleteTaskPanel';
import { TasksTable } from './TasksTable';
import styles from '../admin.module.css';

/** Tasks section: all-tasks table + admin task deletion. */
export default function TasksPage() {
  return (
    <div>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Tasks</h1>
        <p className={styles.pageSubtitle}>Browse every task and remove any task by id.</p>
      </div>

      <TasksTable />

      <div style={{ height: '1.5rem' }} />
      <DeleteTaskPanel />
    </div>
  );
}
