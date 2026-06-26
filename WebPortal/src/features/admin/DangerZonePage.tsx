import { Alert } from '../../components/ui/Alert';
import { DeleteUserPanel } from './users/DeleteUserPanel';
import { DeleteTaskPanel } from './tasks/DeleteTaskPanel';
import styles from './admin.module.css';

/**
 * Consolidated destructive operations. Each action requires typed confirmation and shows its
 * audit result (deletion counts / deleted payload) inline after completion.
 */
export default function DangerZonePage() {
  return (
    <div>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Dangerous Actions</h1>
        <p className={styles.pageSubtitle}>
          Irreversible operations. Each one requires typed confirmation and reports its audit
          result below the form.
        </p>
      </div>

      <div style={{ marginBottom: '1.25rem' }}>
        <Alert variant="warning" title="These actions cannot be undone">
          Deletions permanently remove data from DynamoDB, S3, and Cognito. Double-check the id
          before confirming.
        </Alert>
      </div>

      <div className={`${styles.sectionGrid} ${styles.sectionGridTwo}`}>
        <DeleteUserPanel />
        <DeleteTaskPanel />
      </div>
    </div>
  );
}
