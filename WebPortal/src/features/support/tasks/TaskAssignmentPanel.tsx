import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Send, Users } from 'lucide-react';
import {
  useCreateTaskAssignment,
  useMyOrganizationUsers,
  useMySupportList,
} from '../../../api/supportHooks';
import { gqlErrorMessage, hasGraphqlErrorResponse } from '../../../api/graphqlError';
import type { TaskAssignment } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select, type SelectOption } from '../../../components/ui/Select';
import { Spinner } from '../../../components/ui/Spinner';
import { Panel } from '../../admin/components/Panel';
import {
  AssignmentScheduleFields,
  assignmentInputFromDraft,
  createDefaultScheduleDraft,
  validateAssignmentSchedule,
} from './AssignmentScheduleFields';
import { describeSchedule } from './taskSchedule';
import adminStyles from '../../admin/admin.module.css';

/**
 * Creates a schedule for one template owned by the signed-in SupportPerson. Existing schedule
 * management is user-centric and lives below the supported user's calendar instead.
 */
export function TaskAssignmentPanel({
  taskId,
  initialTargetUserId,
}: {
  taskId: string;
  initialTargetUserId?: string;
}) {
  const supportListQuery = useMySupportList();
  const orgUsersQuery = useMyOrganizationUsers();
  const createMutation = useCreateTaskAssignment();

  const [targetUserId, setTargetUserId] = useState('');
  const [draft, setDraft] = useState(createDefaultScheduleDraft);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [lastCreated, setLastCreated] = useState<TaskAssignment | null>(null);
  const [createOutcomeUnknown, setCreateOutcomeUnknown] = useState(false);
  const formLocked = createMutation.isPending || createOutcomeUnknown;

  /** Only currently-effective ACTIVE links may be assignment targets. */
  const activeLinks = useMemo(
    () => (supportListQuery.data?.items ?? []).filter((link) => link.status === 'ACTIVE'),
    [supportListQuery.data],
  );
  const appliedInitialTarget = useRef<string | null>(null);

  useEffect(() => {
    const nextTarget = initialTargetUserId?.trim();
    if (!nextTarget) {
      appliedInitialTarget.current = null;
      return;
    }
    if (
      supportListQuery.isLoading ||
      supportListQuery.isError ||
      appliedInitialTarget.current === nextTarget
    ) {
      return;
    }
    if (activeLinks.some((link) => link.primaryUserId === nextTarget)) {
      appliedInitialTarget.current = nextTarget;
      setTargetUserId(nextTarget);
    }
  }, [activeLinks, initialTargetUserId, supportListQuery.isError, supportListQuery.isLoading]);

  const rosterNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of orgUsersQuery.data?.items ?? []) {
      if (member.displayName) names.set(member.userId, member.displayName);
    }
    return names;
  }, [orgUsersQuery.data]);

  const nameOf = (userId: string) => rosterNames.get(userId) ?? userId;
  const targetOptions: SelectOption[] = [
    { value: '', label: 'Select a person…' },
    ...activeLinks.map((link) => ({
      value: link.primaryUserId,
      label: nameOf(link.primaryUserId),
    })),
  ];

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (formLocked) return;

    const errors = validateAssignmentSchedule(draft);
    if (!targetUserId || !activeLinks.some((link) => link.primaryUserId === targetUserId)) {
      errors.target = 'Choose a person you actively support.';
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setLastCreated(null);
    setCreateOutcomeUnknown(false);
    createMutation.mutate(assignmentInputFromDraft(taskId, targetUserId, draft), {
      onSuccess: (assignment) => {
        setLastCreated(assignment);
        setDraft((current) => ({ ...current, oneTimeAt: '' }));
      },
      onError: (error) => {
        if (hasGraphqlErrorResponse(error)) return;
        setCreateOutcomeUnknown(true);
        window.requestAnimationFrame(() => {
          document.getElementById('review-created-assignment-outcome')?.focus();
        });
      },
    });
  }

  const supportListReady = !supportListQuery.isLoading && !supportListQuery.isError;
  const normalizedInitialTarget = initialTargetUserId?.trim() ?? '';
  const initialTargetIsActive = activeLinks.some(
    (link) => link.primaryUserId === normalizedInitialTarget,
  );
  const initialTargetIsSelected = initialTargetIsActive && targetUserId === normalizedInitialTarget;

  return (
    <Panel
      title="Assign this task"
      description="Create a one-time or recurring schedule from this template. Manage or replace existing schedules from the supported user's calendar page."
      icon={<CalendarClock size={16} />}
    >
      {supportListQuery.isLoading ? (
        <div style={{ padding: '1.5rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading your support list…" />
        </div>
      ) : supportListQuery.isError ? (
        <Alert variant="error" title="Could not load your support list">
          {gqlErrorMessage(supportListQuery.error)}
        </Alert>
      ) : activeLinks.length === 0 ? (
        <EmptyState
          icon={<Users size={30} />}
          title="No one to assign to"
          description="You are not actively supporting anyone yet."
        />
      ) : null}

      {supportListReady && activeLinks.length === 0 && (
        <p style={{ textAlign: 'center', margin: '0.5rem 0 0' }}>
          <Link to="/support/manage">Add people on the Manage people page</Link>
        </p>
      )}

      {supportListReady && activeLinks.length > 0 && (
        <>
          {normalizedInitialTarget && initialTargetIsSelected && (
            <div style={{ marginBottom: '0.85rem' }}>
              <Alert variant="info" title="Supported user preselected">
                The assignment form is ready for {nameOf(normalizedInitialTarget)}.
              </Alert>
            </div>
          )}
          {normalizedInitialTarget && !initialTargetIsActive && (
            <div style={{ marginBottom: '0.85rem' }}>
              <Alert variant="warning" title="That user is no longer available">
                Choose someone from your current support list before assigning this task.
              </Alert>
            </div>
          )}

          <form className={adminStyles.panelForm} onSubmit={handleCreate} noValidate>
            <Select
              label="Assign to"
              required
              options={targetOptions}
              value={targetUserId}
              error={formErrors.target}
              disabled={formLocked}
              hint="Only people with an active support link are listed."
              onChange={(event) => setTargetUserId(event.target.value)}
            />

            <AssignmentScheduleFields
              idPrefix={`create-${taskId}`}
              draft={draft}
              errors={formErrors}
              disabled={formLocked}
              onChange={setDraft}
            />

            {createMutation.isError && (
              <Alert
                variant="error"
                title={
                  createOutcomeUnknown
                    ? 'Could not confirm whether the assignment was created'
                    : 'Could not create the assignment'
                }
              >
                {gqlErrorMessage(createMutation.error)}{' '}
                {createOutcomeUnknown && targetUserId && (
                  <>
                    The request may have reached the backend.{' '}
                    <Link
                      id="review-created-assignment-outcome"
                      to={`/support/users/${encodeURIComponent(targetUserId)}#assignments`}
                    >
                      Review this user's schedules
                    </Link>{' '}
                    before assigning again so you do not create a duplicate.
                  </>
                )}
              </Alert>
            )}
            {lastCreated && !createMutation.isError && (
              <Alert variant="success" title="Assignment created">
                {nameOf(lastCreated.userId)} — {describeSchedule(lastCreated)}.{' '}
                <Link to={`/support/users/${encodeURIComponent(lastCreated.userId)}#assignments`}>
                  Manage schedule
                </Link>
              </Alert>
            )}

            <div className={adminStyles.formActions}>
              <Button
                type="submit"
                icon={<Send size={15} />}
                loading={createMutation.isPending}
                disabled={createOutcomeUnknown}
              >
                Assign task
              </Button>
            </div>
          </form>
        </>
      )}
    </Panel>
  );
}
