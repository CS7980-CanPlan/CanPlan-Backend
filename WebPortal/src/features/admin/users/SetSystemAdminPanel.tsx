import { useState, type FormEvent } from 'react';
import { ShieldCheck, ShieldMinus } from 'lucide-react';
import { useSetSystemAdmin } from '../../../api/adminHooks';
import type { AdminUserResult } from '../../../api/apiTypes';
import { useAuth } from '../../../auth/useAuth';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import { AdminUserResultBody } from './AdminUserResultBody';
import styles from '../admin.module.css';

const ENABLED_OPTIONS = [
  { value: 'true', label: 'Grant SystemAdmin' },
  { value: 'false', label: 'Revoke SystemAdmin' },
];

/** Grant or revoke the elevated SystemAdmin group. */
export function SetSystemAdminPanel() {
  const mutation = useSetSystemAdmin();
  const { user } = useAuth();
  const [userId, setUserId] = useState('');
  const [enabled, setEnabled] = useState(true);

  const isSelfRevoke = !enabled && userId.trim() === user?.userId;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ userId: userId.trim(), enabled });
  }

  return (
    <Panel
      title="Set SystemAdmin"
      description="Grants or revokes the elevated SystemAdmin group only. Base roles are untouched."
      icon={<ShieldCheck size={16} />}
    >
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <div className={`${styles.formRow} ${styles.formRowTwo}`}>
          <TextField
            label="User id (Cognito sub)"
            required
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. 8e1c…"
          />
          <Select
            label="Action"
            value={enabled ? 'true' : 'false'}
            onChange={(e) => setEnabled(e.target.value === 'true')}
            options={ENABLED_OPTIONS}
          />
        </div>
        {isSelfRevoke && (
          <Alert variant="warning">
            You cannot revoke SystemAdmin from your own account — the backend rejects self-demotion.
          </Alert>
        )}
        <div className={styles.formActions}>
          <Button
            type="submit"
            variant={enabled ? 'primary' : 'danger'}
            icon={enabled ? <ShieldCheck size={16} /> : <ShieldMinus size={16} />}
            loading={mutation.isPending}
            disabled={!userId.trim() || isSelfRevoke}
          >
            {enabled ? 'Grant SystemAdmin' : 'Revoke SystemAdmin'}
          </Button>
        </div>
      </form>

      <MutationResultPanel<AdminUserResult>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="SystemAdmin updated"
        renderSuccess={(data) => <AdminUserResultBody result={data} />}
      />
    </Panel>
  );
}
