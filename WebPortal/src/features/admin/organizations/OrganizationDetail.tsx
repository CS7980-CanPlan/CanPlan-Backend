import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Pencil, Trash2, X } from 'lucide-react';
import { useAdminDeleteOrganization, useAdminUpdateOrganization } from '../../../api/adminHooks';
import type { AdminDeleteOrganizationResult, Organization } from '../../../api/apiTypes';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import { ConfirmDangerAction, confirmationMatches } from '../components/ConfirmDangerAction';
import { IdCell } from '../components/display';
import { AddMemberPanel } from './AddMemberPanel';
import { OrganizationMembersTable } from './OrganizationMembersTable';
import styles from '../admin.module.css';

interface OrganizationDetailProps {
  org: Organization;
  /** Called with the updated org after a rename so the parent keeps the selection in sync. */
  onRenamed: (org: Organization) => void;
  /** Called to close the detail (also used after a successful delete). */
  onClose: () => void;
}

/** The selected organization's management surface: members, add/remove, rename, delete. */
export function OrganizationDetail({ org, onRenamed, onClose }: OrganizationDetailProps) {
  return (
    <section aria-label={`Manage ${org.name}`}>
      <div className={styles.pageHead} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ minWidth: 0 }}>
          <h2 className={styles.sectionTitle} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Building2 size={18} aria-hidden="true" /> {org.name}
          </h2>
          <div className={styles.pageSubtitle}>
            <IdCell id={org.organizationId} />
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" icon={<X size={15} />} onClick={onClose}>
          Close
        </Button>
      </div>

      <OrganizationMembersTable key={org.organizationId} org={org} />

      <div style={{ height: '1.25rem' }} />

      <div className={`${styles.sectionGrid} ${styles.sectionGridTwo}`}>
        <AddMemberPanel org={org} />
        <RenameOrganizationPanel org={org} onRenamed={onRenamed} />
      </div>

      <div style={{ height: '1.25rem' }} />
      <DeleteOrganizationPanel org={org} onDeleted={onClose} />
    </section>
  );
}

/** Rename the selected organization (adminUpdateOrganization). */
function RenameOrganizationPanel({
  org,
  onRenamed,
}: {
  org: Organization;
  onRenamed: (org: Organization) => void;
}) {
  const mutation = useAdminUpdateOrganization();
  const [name, setName] = useState(org.name);

  // Re-sync the field when a different org is selected (or its name changes elsewhere).
  useEffect(() => setName(org.name), [org.organizationId, org.name]);

  const trimmed = name.trim();
  const changed = trimmed.length > 0 && trimmed !== org.name;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!changed) return;
    mutation.mutate(
      { organizationId: org.organizationId, name: trimmed },
      { onSuccess: (updated) => onRenamed(updated) },
    );
  }

  return (
    <Panel title="Rename organization" description="Update the organization's display name." icon={<Pencil size={16} />}>
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <div className={styles.formActions}>
          <Button type="submit" icon={<Pencil size={16} />} loading={mutation.isPending} disabled={!changed}>
            Save name
          </Button>
        </div>
      </form>
      <MutationResultPanel<Organization>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Organization renamed"
        renderSuccess={(updated) => (
          <span>
            Renamed to <strong>{updated.name}</strong>.
          </span>
        )}
      />
    </Panel>
  );
}

/** Destructive: delete the org and detach every member, gated by typed confirmation. */
function DeleteOrganizationPanel({ org, onDeleted }: { org: Organization; onDeleted: () => void }) {
  const mutation = useAdminDeleteOrganization();
  const [confirm, setConfirm] = useState('');
  const canSubmit = confirmationMatches(org.name, confirm);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      { organizationId: org.organizationId },
      {
        onSuccess: () => {
          setConfirm('');
          onDeleted();
        },
      },
    );
  }

  return (
    <Panel
      title="Delete organization"
      description="Removes the organization and detaches every member (each member's profile is updated). This cannot be undone."
      icon={<Trash2 size={16} />}
    >
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <ConfirmDangerAction
          expected={org.name}
          value={confirm}
          onChange={setConfirm}
          targetLabel="organization name"
        />
        <div className={styles.formActions}>
          <Button type="submit" variant="danger" icon={<Trash2 size={16} />} loading={mutation.isPending} disabled={!canSubmit}>
            Permanently delete organization
          </Button>
        </div>
      </form>
      <MutationResultPanel<AdminDeleteOrganizationResult>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Organization deleted"
        renderSuccess={(result) => (
          <span>
            Deleted <strong>{result.organization.name}</strong> and detached {result.removedUsers} member(s).
          </span>
        )}
      />
    </Panel>
  );
}
