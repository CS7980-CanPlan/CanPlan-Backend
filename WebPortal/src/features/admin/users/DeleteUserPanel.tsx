import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useAdminDeleteUser } from '../../../api/adminHooks';
import type { AdminDeleteUserResult } from '../../../api/apiTypes';
import { useAuth } from '../../../auth/useAuth';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import { ConfirmDangerAction, confirmationMatches } from '../components/ConfirmDangerAction';
import styles from '../admin.module.css';

/** Destructive: fully delete a user (tasks, partition rows, support links, Cognito login). */
export function DeleteUserPanel() {
  const mutation = useAdminDeleteUser();
  const { user } = useAuth();
  const [userId, setUserId] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleteCognitoUser, setDeleteCognitoUser] = useState(true);
  const [disableFirst, setDisableFirst] = useState(true);

  const target = userId.trim();
  const isSelf = target.length > 0 && target === user?.userId;
  const canSubmit = confirmationMatches(target, confirm) && !isSelf;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      { userId: target, deleteCognitoUser, disableFirst },
      { onSuccess: () => setConfirm('') },
    );
  }

  return (
    <Panel
      title="Delete user"
      description="Permanently removes a user and all of their data. This cannot be undone."
      icon={<Trash2 size={16} />}
    >
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <TextField
          label="User id (Cognito sub)"
          required
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setConfirm('');
          }}
          placeholder="e.g. 8e1c…"
        />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
          <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', fontSize: '0.8125rem' }}>
            <input type="checkbox" checked={deleteCognitoUser} onChange={(e) => setDeleteCognitoUser(e.target.checked)} />
            Delete Cognito login
          </label>
          <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', fontSize: '0.8125rem' }}>
            <input
              type="checkbox"
              checked={disableFirst}
              onChange={(e) => setDisableFirst(e.target.checked)}
              disabled={!deleteCognitoUser}
            />
            Disable before deleting
          </label>
        </div>

        {isSelf && <Alert variant="warning">You cannot delete your own account.</Alert>}

        <ConfirmDangerAction expected={target} value={confirm} onChange={setConfirm} targetLabel="user id" />

        <div className={styles.formActions}>
          <Button type="submit" variant="danger" icon={<Trash2 size={16} />} loading={mutation.isPending} disabled={!canSubmit}>
            Permanently delete user
          </Button>
        </div>
      </form>

      <MutationResultPanel<AdminDeleteUserResult>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="User deleted"
      />
    </Panel>
  );
}
