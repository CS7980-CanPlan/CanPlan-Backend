import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import { useAdminSetUserOrganization, useUserData, useUsersPage } from '../../../api/adminHooks';
import type { Organization, UserProfile } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import styles from '../admin.module.css';

/** MVP picker size — the add-member dropdown lists the first N users (no user-search API yet). */
const PICKER_LIMIT = 100;

/** Wait this long after the last keystroke before looking a typed ID up, so pasting/typing a
 * full ID fires one query instead of one per character. */
const LOOKUP_DEBOUNCE_MS = 300;

function userLabel(user: UserProfile): string {
  const name = user.displayName ?? user.email ?? user.userId;
  return user.organizationId ? `${name} — currently in ${user.organizationId}` : name;
}

/** Short human label for a profile, for the ready/error banners. */
function profileName(profile: UserProfile): string {
  return profile.displayName ?? profile.email ?? profile.userId;
}

/** Assign a user (by dropdown pick or exact-ID search) to the selected org via adminSetUserOrganization. */
export function AddMemberPanel({ org }: { org: Organization }) {
  const usersQuery = useUsersPage({ limit: PICKER_LIMIT });
  const mutation = useAdminSetUserOrganization();
  const [rawId, setRawId] = useState('');
  const enteredId = rawId.trim();

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

  // If the typed ID is already in the loaded page we can validate it without a network call.
  const listedUser = enteredId ? users.find((u) => u.userId === enteredId) : undefined;

  // Debounce the entered ID, then look it up by exact ID (covers users beyond the first 100).
  const [lookupId, setLookupId] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setLookupId(enteredId), LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enteredId]);
  const shouldLookup = Boolean(lookupId) && lookupId === enteredId && !listedUser;
  const lookup = useUserData(shouldLookup ? lookupId : undefined);

  const resolvedProfile = listedUser ?? (shouldLookup ? lookup.data?.profile ?? null : null);
  const isTyping = Boolean(enteredId) && !listedUser && lookupId !== enteredId;
  const isChecking = shouldLookup && lookup.isLoading;
  const notFound = shouldLookup && !lookup.isLoading && !resolvedProfile;
  const alreadyInOrg = Boolean(resolvedProfile) && resolvedProfile?.organizationId === org.organizationId;
  const readyToAdd = Boolean(resolvedProfile) && !alreadyInOrg;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!enteredId || !readyToAdd) return;
    mutation.mutate(
      { userId: enteredId, organizationId: org.organizationId },
      { onSuccess: () => setRawId('') },
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
          <TextField
            label="Search by user ID"
            placeholder="Paste an exact user ID…"
            value={rawId}
            onChange={(e) => setRawId(e.target.value)}
            hint="Add anyone by exact ID — including users beyond the first 100 below."
            autoComplete="off"
            spellCheck={false}
          />

          {enteredId && alreadyInOrg && (
            <Alert variant="error" title="Already a member">
              <strong>{resolvedProfile ? profileName(resolvedProfile) : enteredId}</strong> is already in{' '}
              {org.name}.
            </Alert>
          )}
          {enteredId && notFound && (
            <Alert variant="error" title="No user found">
              No user matches ID “{enteredId}”. Check the ID and try again.
            </Alert>
          )}
          {enteredId && (isTyping || isChecking) && !alreadyInOrg && (
            <span className={styles.mutedText}>Looking up user…</span>
          )}
          {enteredId && readyToAdd && resolvedProfile && (
            <Alert variant="success" title="User found">
              Ready to add <strong>{profileName(resolvedProfile)}</strong>
              {resolvedProfile.organizationId ? ` (currently in ${resolvedProfile.organizationId})` : ''}.
            </Alert>
          )}

          <Select
            label="Or pick from the list"
            value={listedUser ? enteredId : ''}
            onChange={(e) => setRawId(e.target.value)}
            options={options}
            disabled={usersQuery.isLoading}
            hint="Users already in this organization are hidden. Showing the first 100 users."
          />
          <div className={styles.formActions}>
            <Button
              type="submit"
              icon={<UserPlus size={16} />}
              loading={mutation.isPending}
              disabled={!readyToAdd}
            >
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
