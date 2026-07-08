import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Users as UsersIcon } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { authErrorMessage } from '../../auth/authError';
import {
  useMyOrganizationUsers,
  useMySupportList,
  useSelectPrimaryUser,
  useUnselectPrimaryUser,
} from '../../api/supportHooks';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { RosterUserCard, SupportedUserCard } from './userCards';
import adminStyles from '../admin/admin.module.css';
import styles from './support.module.css';

/**
 * Manage people at `/support/manage`. Add primary users from the caller's OWN organization
 * (`listMyOrganizationUsers` only ever returns the caller's org, so users in other orgs are
 * never visible) via `selectPrimaryUser`, and remove existing ones via `unselectPrimaryUser`.
 */
export default function SupportManagePage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const supportList = useMySupportList();
  const orgUsers = useMyOrganizationUsers();
  const selectMutation = useSelectPrimaryUser();
  const unselectMutation = useUnselectPrimaryUser();

  const activeLinks = (supportList.data?.items ?? []).filter((link) => link.status === 'ACTIVE');
  const activeIds = new Set(activeLinks.map((link) => link.primaryUserId));

  // Roster primary users in the caller's org, not already supported, never the caller.
  const candidates = (orgUsers.data?.items ?? []).filter(
    (u) => u.role === 'PRIMARY_USER' && u.userId !== user?.userId && !activeIds.has(u.userId),
  );

  const openUser = (userId: string) => navigate(`/support/users/${encodeURIComponent(userId)}`);
  const mutationError = selectMutation.error ?? unselectMutation.error;

  return (
    <div>
      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>Manage people</h1>
        <p className={adminStyles.pageSubtitle}>
          Add or remove the primary users you support. You can only see and select primary users
          in your own organization.
        </p>
      </div>

      {mutationError && (
        <div style={{ marginBottom: '1rem' }}>
          <Alert variant="error" title="Could not update your support list">
            {authErrorMessage(mutationError)}
          </Alert>
        </div>
      )}

      {/* ── People you support (remove) ────────────────────────────────────── */}
      <Section
        title="People you support"
        count={activeLinks.length}
        action={
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => supportList.refetch()}
            disabled={supportList.isFetching}
          >
            Refresh
          </Button>
        }
      >
        {supportList.isError ? (
          <Alert variant="error" title="Could not load your support list">
            Please try refreshing. If this persists, confirm you are signed in as a support person.
          </Alert>
        ) : supportList.isLoading ? (
          <Centered>
            <Spinner label="Loading your support list…" />
          </Centered>
        ) : activeLinks.length === 0 ? (
          <div className={adminStyles.tableCard}>
            <EmptyState
              icon={<UsersIcon size={32} />}
              title="You're not supporting anyone yet"
              description="Select a primary user from your organization below to start supporting them."
            />
          </div>
        ) : (
          <div className={styles.userList}>
            {activeLinks.map((link) => (
              <SupportedUserCard
                key={link.primaryUserId}
                userId={link.primaryUserId}
                onOpen={openUser}
                onRemove={(id) => unselectMutation.mutate({ primaryUserId: id })}
                removing={
                  unselectMutation.isPending &&
                  unselectMutation.variables?.primaryUserId === link.primaryUserId
                }
              />
            ))}
          </div>
        )}
      </Section>

      {/* ── Add someone to support ─────────────────────────────────────────── */}
      <Section
        title="Add someone to support"
        count={candidates.length}
        action={
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => orgUsers.refetch()}
            disabled={orgUsers.isFetching}
          >
            Refresh
          </Button>
        }
      >
        {orgUsers.isError ? (
          <Alert variant="warning" title="Could not load your organization">
            {authErrorMessage(orgUsers.error)} You must belong to an organization to select the
            primary users in it — set your organization on the My profile page.
          </Alert>
        ) : orgUsers.isLoading ? (
          <Centered>
            <Spinner label="Loading organization members…" />
          </Centered>
        ) : candidates.length === 0 ? (
          <div className={adminStyles.tableCard}>
            <EmptyState
              icon={<UsersIcon size={32} />}
              title="No one to add"
              description="Every primary user in your organization is already on your list."
            />
          </div>
        ) : (
          <div className={styles.userList}>
            {candidates.map((candidate) => (
              <RosterUserCard
                key={candidate.userId}
                user={candidate}
                onSelect={(id) => selectMutation.mutate({ primaryUserId: id })}
                selecting={
                  selectMutation.isPending &&
                  selectMutation.variables?.primaryUserId === candidate.userId
                }
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <div className={adminStyles.toolbar}>
        <h2 className={adminStyles.sectionTitle} style={{ margin: 0 }}>
          {title}
          <span className={adminStyles.sectionCount}>({count})</span>
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ padding: '2rem', display: 'grid', placeItems: 'center' }}>{children}</div>;
}
