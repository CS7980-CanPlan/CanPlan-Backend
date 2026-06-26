import { useState, type FormEvent } from 'react';
import { UserCog } from 'lucide-react';
import { useSetUserBaseRole } from '../../../api/adminHooks';
import type { AdminBaseRole, AdminUserResult } from '../../../api/apiTypes';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import { AdminUserResultBody } from './AdminUserResultBody';
import styles from '../admin.module.css';

const ROLE_OPTIONS: { value: AdminBaseRole; label: string }[] = [
  { value: 'PRIMARY_USER', label: 'Primary user' },
  { value: 'SUPPORT_PERSON', label: 'Support person' },
  { value: 'ORG_ADMIN', label: 'Org admin' },
];

/** Move an existing user between the three mutually-exclusive base roles. */
export function SetBaseRolePanel() {
  const mutation = useSetUserBaseRole();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<AdminBaseRole>('SUPPORT_PERSON');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ userId: userId.trim(), role });
  }

  return (
    <Panel
      title="Set base role"
      description="Swaps the user's single base group (PrimaryUser / SupportPerson / OrganizationAdmin). SystemAdmin is unaffected."
      icon={<UserCog size={16} />}
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
            label="New base role"
            value={role}
            onChange={(e) => setRole(e.target.value as AdminBaseRole)}
            options={ROLE_OPTIONS}
          />
        </div>
        <div className={styles.formActions}>
          <Button type="submit" icon={<UserCog size={16} />} loading={mutation.isPending} disabled={!userId.trim()}>
            Update role
          </Button>
        </div>
      </form>

      <MutationResultPanel<AdminUserResult>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Role updated"
        renderSuccess={(data) => <AdminUserResultBody result={data} />}
      />
    </Panel>
  );
}
