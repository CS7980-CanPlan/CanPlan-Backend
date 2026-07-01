import { useMemo, useState, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import { useAdminSetUserOrganization, useUsersPage } from '../../../api/adminHooks';
import type { Organization, UserProfile } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import styles from '../admin.module.css';

/** MVP picker size — the add-member dropdown lists the first N users (no user-search API yet). */
const PICKER_LIMIT = 100;

function userLabel(user: UserProfile): string {
  const name = user.displayName ?? user.email ?? user.userId;
  return user.organizationId ? `${name} — currently in ${user.organizationId}` : name;
}

/** Assign a user (chosen from listAllUsers) to the selected org via adminSetUserOrganization. */
export function AddMemberPanel({ org }: { org: Organization }) {
  const usersQuery = useUsersPage({ limit: PICKER_LIMIT });
  const mutation = useAdminSetUserOrganization();
  const [userId, setUserId] = useState('');

  const users = usersQuery.data?.items ?? [];
  const options = useMemo(() => {
    // Users already in THIS org are hidden (they're in the members table above).
    const selectable = users
      .filter((u) => u.organizationId !== org.organizationId)
      .map((u) => ({ value: u.userId, label: userLabel(u) }));
    const placeholder = {
      value: '',
      label: selectable.length ? 'Select a user…' : 'No other users available',
    };
    return [placeholder, ...selectable];
  }, [users, org.organizationId]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!userId) return;
    mutation.mutate(
      { userId, organizationId: org.organizationId },
      { onSuccess: () => setUserId('') },
    );
  }

  return (
    <Panel
      title="Add a member"
      description={`Assign a user to ${org.name}. Moving a user from another org updates it automatically.`}
      icon={<UserPlus size={16} />}
    >
      {usersQuery.isError ? (
        <Alert variant="error" title="Could not load users">
          Refresh and try again.
        </Alert>
      ) : (
        <form className={styles.panelForm} onSubmit={handleSubmit}>
          <Select
            label="User"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            options={options}
            disabled={usersQuery.isLoading}
            hint="Users already in this organization are hidden. Showing the first 100 users."
          />
          <div className={styles.formActions}>
            <Button type="submit" icon={<UserPlus size={16} />} loading={mutation.isPending} disabled={!userId}>
              Add to organization
            </Button>
          </div>
        </form>
      )}

      <MutationResultPanel<UserProfile>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Member added"
        renderSuccess={(profile) => (
          <span>
            <strong>{profile.displayName ?? profile.userId}</strong> is now in this organization.
          </span>
        )}
      />
    </Panel>
  );
}
