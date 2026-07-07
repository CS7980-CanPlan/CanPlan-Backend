import { useState } from 'react';
import type { Organization } from '../../../api/apiTypes';
import { CreateOrganizationPanel } from './CreateOrganizationPanel';
import { OrganizationDetail } from './OrganizationDetail';
import { OrganizationsTable } from './OrganizationsTable';
import styles from '../admin.module.css';

/**
 * Organizations section: browse/create organizations and manage the selected org's members.
 * Selecting ("Manage") an org — or creating one — opens its detail surface below.
 */
export default function OrganizationsPage() {
  const [selected, setSelected] = useState<Organization | null>(null);

  return (
    <div>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Organizations</h1>
        <p className={styles.pageSubtitle}>
          Create organizations and manage their members. Ids are generated on create.
        </p>
      </div>

      <OrganizationsTable selectedId={selected?.organizationId} onManage={setSelected} />

      <div style={{ height: '1.25rem' }} />
      <CreateOrganizationPanel onCreated={setSelected} />

      {selected && (
        <>
          <div style={{ height: '1.75rem' }} />
          <OrganizationDetail
            org={selected}
            onRenamed={setSelected}
            onClose={() => setSelected(null)}
          />
        </>
      )}
    </div>
  );
}
