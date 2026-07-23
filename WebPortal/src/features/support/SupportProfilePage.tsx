import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Building2, Save } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { authErrorMessage } from '../../auth/authError';
import { useUpdateMyUserProfile, useUserProfile } from '../../api/supportHooks';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { TextField } from '../../components/ui/TextField';
import { Panel } from '../admin/components/Panel';
import { IdCell, RoleBadge } from '../admin/components/display';
import adminStyles from '../admin/admin.module.css';

/**
 * The support person's own profile at `/support/profile`. Edits displayName and organization
 * membership via `updateMyUserProfile` (self-only). Organizations can't be browsed by a
 * non-admin (listAllOrganizations is SystemAdmin-only), so the org field is a search-by-ID
 * input: paste an organization's id to join it; the backend validates that it exists.
 */
export default function SupportProfilePage() {
  const { user } = useAuth();
  const myId = user?.userId;

  const profileQuery = useUserProfile(myId);
  const profile = profileQuery.data;
  const updateMutation = useUpdateMyUserProfile(myId);

  const [displayName, setDisplayName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Seed the form from the loaded profile (and re-seed after a save re-fetches it).
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName ?? '');
      setOrgId(profile.organizationId ?? '');
    }
  }, [profile?.displayName, profile?.organizationId]);

  function save(organizationId: string | null) {
    setFormError(null);
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setFormError('Display name is required.');
      return;
    }
    updateMutation.mutate({ displayName: trimmedName, organizationId });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedOrg = orgId.trim();
    save(trimmedOrg === '' ? null : trimmedOrg);
  }

  function handleLeaveOrg() {
    setOrgId('');
    save(null);
  }

  return (
    <div>
      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>My profile</h1>
        <p className={adminStyles.pageSubtitle}>
          Update your personal information and organization membership.
        </p>
      </div>

      <Panel title="Profile" description="Your own profile record. Email and role are managed for you.">
        {profileQuery.isLoading ? (
          <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>
            <Spinner label="Loading your profile…" />
          </div>
        ) : profileQuery.isError ? (
          <Alert variant="error" title="Could not load your profile">
            {authErrorMessage(profileQuery.error)}
          </Alert>
        ) : !profile ? (
          <Alert variant="warning" title="No profile yet">
            Your profile record hasn't been created yet. Complete first-time setup in the CanPlan
            app, then come back here.
          </Alert>
        ) : (
          <form className={adminStyles.panelForm} onSubmit={handleSubmit} noValidate>
            <div className={adminStyles.detailGrid}>
              <ReadOnly label="Email" value={profile.email ?? '—'} />
              <ReadOnly label="Role" value={<RoleBadge role={profile.role} />} />
              <ReadOnly label="User id (sub)" value={<IdCell id={profile.userId} />} />
              <ReadOnly
                label="Current organization"
                value={profile.organizationId ? <IdCell id={profile.organizationId} /> : 'None'}
              />
            </div>

            <TextField
              label="Display name"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />

            <TextField
              label="Organization ID"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              placeholder="Search / paste an organization ID"
              hint="Enter an organization's ID to join it (ask your administrator for it). Clearing this field and saving leaves your current organization."
            />

            {formError && <Alert variant="error">{formError}</Alert>}
            {updateMutation.isError && (
              <Alert variant="error" title="Could not save your profile">
                {authErrorMessage(updateMutation.error)}
              </Alert>
            )}
            {updateMutation.isSuccess && !updateMutation.isPending && (
              <Alert variant="success">Your profile has been updated.</Alert>
            )}

            <div className={adminStyles.formActions}>
              <Button
                type="submit"
                icon={<Save size={16} />}
                loading={updateMutation.isPending}
              >
                Save changes
              </Button>
              {profile.organizationId && (
                <Button
                  type="button"
                  variant="ghost"
                  icon={<Building2 size={16} />}
                  disabled={updateMutation.isPending}
                  onClick={handleLeaveOrg}
                >
                  Leave organization
                </Button>
              )}
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={adminStyles.detailItem}>
      <span className={adminStyles.detailLabel}>{label}</span>
      <span className={adminStyles.detailValue}>{value}</span>
    </div>
  );
}
