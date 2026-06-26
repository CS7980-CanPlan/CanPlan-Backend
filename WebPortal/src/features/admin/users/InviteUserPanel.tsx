import { useState, type FormEvent, type ReactNode } from 'react';
import { Building2, LifeBuoy, UserPlus } from 'lucide-react';
import { useInviteOrganizationAdmin, useInviteSupportPerson } from '../../../api/adminHooks';
import type { AdminUserResult, InviteUserInput } from '../../../api/apiTypes';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import { AdminUserResultBody } from './AdminUserResultBody';
import styles from '../admin.module.css';

type InviteVariant = 'SUPPORT_PERSON' | 'ORG_ADMIN';

const COPY: Record<InviteVariant, { title: string; desc: string; group: string; icon: ReactNode }> = {
  SUPPORT_PERSON: {
    title: 'Invite support person',
    desc: 'Creates (or adopts) a Cognito user and adds the SupportPerson group.',
    group: 'SupportPerson',
    icon: <LifeBuoy size={16} />,
  },
  ORG_ADMIN: {
    title: 'Invite organization admin',
    desc: 'Creates (or adopts) a Cognito user and adds the OrganizationAdmin group.',
    group: 'OrganizationAdmin',
    icon: <Building2 size={16} />,
  },
};

/** Invite form for SupportPerson or OrganizationAdmin (parameterized by `variant`). */
export function InviteUserPanel({ variant }: { variant: InviteVariant }) {
  const copy = COPY[variant];
  const supportMutation = useInviteSupportPerson();
  const orgMutation = useInviteOrganizationAdmin();
  const mutation = variant === 'SUPPORT_PERSON' ? supportMutation : orgMutation;

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationId, setOrganizationId] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const input: InviteUserInput = { email: email.trim() };
    if (displayName.trim()) input.displayName = displayName.trim();
    if (organizationId.trim()) input.organizationId = organizationId.trim();
    mutation.mutate(input, {
      onSuccess: () => {
        setEmail('');
        setDisplayName('');
        setOrganizationId('');
      },
    });
  }

  return (
    <Panel title={copy.title} description={copy.desc} icon={copy.icon}>
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <TextField
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.com"
        />
        <div className={`${styles.formRow} ${styles.formRowTwo}`}>
          <TextField
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Optional"
          />
          <TextField
            label="Organization id"
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className={styles.formActions}>
          <Button type="submit" icon={<UserPlus size={16} />} loading={mutation.isPending} disabled={!email.trim()}>
            Send invite
          </Button>
        </div>
      </form>

      <MutationResultPanel<AdminUserResult>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Invite sent"
        renderSuccess={(data) => <AdminUserResultBody result={data} />}
      />
    </Panel>
  );
}
