import { useState, type FormEvent } from 'react';
import { Building2, Plus } from 'lucide-react';
import { useAdminCreateOrganization } from '../../../api/adminHooks';
import type { Organization } from '../../../api/apiTypes';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import styles from '../admin.module.css';

/** Create a new organization by name (id is server-generated). Auto-selects it on success. */
export function CreateOrganizationPanel({ onCreated }: { onCreated?: (org: Organization) => void }) {
  const mutation = useAdminCreateOrganization();
  const [name, setName] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    mutation.mutate(
      { name: trimmed },
      {
        onSuccess: (org) => {
          setName('');
          onCreated?.(org);
        },
      },
    );
  }

  return (
    <Panel
      title="Create organization"
      description="Add a new organization. The id is generated automatically."
      icon={<Building2 size={16} />}
    >
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <TextField
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sunrise Care"
        />
        <div className={styles.formActions}>
          <Button type="submit" icon={<Plus size={16} />} loading={mutation.isPending} disabled={!name.trim()}>
            Create organization
          </Button>
        </div>
      </form>

      <MutationResultPanel<Organization>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Organization created"
        renderSuccess={(org) => (
          <span>
            Created <strong>{org.name}</strong> (<code>{org.organizationId}</code>).
          </span>
        )}
      />
    </Panel>
  );
}
