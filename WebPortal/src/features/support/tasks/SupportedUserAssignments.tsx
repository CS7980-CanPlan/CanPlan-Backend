import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarClock,
  CalendarOff,
  ListPlus,
  OctagonX,
  Pencil,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useAuth } from '../../../auth/useAuth';
import {
  useCreateTaskAssignment,
  useDeleteTaskAssignment,
  useEndTaskAssignment,
  useTasksByOwner,
  useUserAssignmentsAll,
} from '../../../api/supportHooks';
import { gqlErrorMessage, hasGraphqlErrorResponse } from '../../../api/graphqlError';
import type { Task, TaskAssignment } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Spinner } from '../../../components/ui/Spinner';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import { formatDate, IdCell } from '../../admin/components/display';
import {
  AssignmentScheduleFields,
  assignmentInputFromDraft,
  replacementEffectiveDate,
  scheduleDraftFromAssignment,
  validateAssignmentSchedule,
  type AssignmentScheduleDraft,
  type AssignmentScheduleErrors,
} from './AssignmentScheduleFields';
import { describeSchedule, parseRrule, todayIsoDateInTimezone } from './taskSchedule';
import adminStyles from '../../admin/admin.module.css';
import styles from './tasks.module.css';

interface PendingAction {
  assignmentId: string;
  kind: 'stop' | 'end';
}

interface UnfinishedReplacement {
  original: TaskAssignment;
  replacement: TaskAssignment;
  effectiveDate: string;
  errorMessage: string;
}

type AssignmentFilter = 'ACTIVE' | 'ENDED_OR_STOPPED' | 'ALL';

export interface SupportedUserAssignmentsProps {
  userId: string;
  displayName: string;
  primaryUserTasks: Task[];
}

/**
 * User-centric schedule management shown below a supported primary user's calendar. The backend
 * has no in-place update mutation, so editing creates a replacement first and then ends the old
 * rule from the replacement's local effective date.
 */
export function SupportedUserAssignments({
  userId,
  displayName,
  primaryUserTasks,
}: SupportedUserAssignmentsProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const assignmentsQuery = useUserAssignmentsAll(userId || undefined);
  const ownedTasksQuery = useTasksByOwner(user?.userId);

  const stopMutation = useDeleteTaskAssignment();
  const endMutation = useEndTaskAssignment();
  const replacementCreateMutation = useCreateTaskAssignment();
  const replacementEndMutation = useEndTaskAssignment();

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [effectiveDateError, setEffectiveDateError] = useState<string>();
  const [editingAssignment, setEditingAssignment] = useState<TaskAssignment | null>(null);
  const [editDraft, setEditDraft] = useState<AssignmentScheduleDraft | null>(null);
  const [editErrors, setEditErrors] = useState<AssignmentScheduleErrors>({});
  const [rowError, setRowError] = useState<{ assignmentId: string; error: unknown } | null>(null);
  const [editError, setEditError] = useState<unknown>(null);
  const [editCreateOutcomeUnknown, setEditCreateOutcomeUnknown] = useState(false);
  const [unfinishedReplacement, setUnfinishedReplacement] = useState<UnfinishedReplacement | null>(
    null,
  );
  const [successMessage, setSuccessMessage] = useState('');
  const [assignmentFilter, setAssignmentFilter] = useState<AssignmentFilter>('ACTIVE');

  const assignments = useMemo(
    () =>
      [...(assignmentsQuery.data ?? [])].sort(
        (left, right) =>
          Number(right.active) - Number(left.active) ||
          (right.assignedAt ?? right.createdAt ?? '').localeCompare(
            left.assignedAt ?? left.createdAt ?? '',
          ) ||
          left.assignmentId.localeCompare(right.assignmentId),
      ),
    [assignmentsQuery.data],
  );
  const activeAssignmentCount = useMemo(
    () => assignments.filter((assignment) => assignment.active).length,
    [assignments],
  );
  const endedOrStoppedAssignmentCount = assignments.length - activeAssignmentCount;
  const filteredAssignments = useMemo(() => {
    if (assignmentFilter === 'ACTIVE') {
      return assignments.filter((assignment) => assignment.active);
    }
    if (assignmentFilter === 'ENDED_OR_STOPPED') {
      return assignments.filter((assignment) => !assignment.active);
    }
    return assignments;
  }, [assignmentFilter, assignments]);

  const ownedTasks = ownedTasksQuery.data?.items ?? [];
  const ownedTaskIds = useMemo(() => new Set(ownedTasks.map((task) => task.taskId)), [ownedTasks]);
  const taskTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const task of primaryUserTasks) titles.set(task.taskId, task.title);
    for (const task of ownedTasks) titles.set(task.taskId, task.title);
    return titles;
  }, [ownedTasks, primaryUserTasks]);

  const actionBusy =
    stopMutation.isPending ||
    endMutation.isPending ||
    replacementCreateMutation.isPending ||
    replacementEndMutation.isPending;
  const filterDisabled = actionBusy || Boolean(editingAssignment) || Boolean(pendingAction);
  const supporterId = user?.userId ?? '';

  useEffect(() => {
    setPendingAction(null);
    setEffectiveDate('');
    setEffectiveDateError(undefined);
    setEditingAssignment(null);
    setEditDraft(null);
    setEditErrors({});
    setRowError(null);
    setEditError(null);
    setEditCreateOutcomeUnknown(false);
    setEffectiveDateError(undefined);
    setUnfinishedReplacement(readUnfinishedReplacement(supporterId, userId));
    setSuccessMessage('');
    setAssignmentFilter('ACTIVE');
  }, [supporterId, userId]);

  function resetFeedback() {
    setRowError(null);
    setEditError(null);
    setEditCreateOutcomeUnknown(false);
    setSuccessMessage('');
  }

  function focusAssignmentStatus() {
    window.requestAnimationFrame(() => {
      document.getElementById('assignment-status')?.focus();
    });
  }

  function focusReplacementWarning() {
    window.requestAnimationFrame(() => {
      document.getElementById('finish-replacement')?.focus();
    });
  }

  function focusFirstEditError() {
    const assignmentId = editingAssignment?.assignmentId;
    if (!assignmentId) return;
    window.requestAnimationFrame(() => {
      document
        .getElementById(`edit-form-${assignmentId}`)
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
    });
  }

  function changeAssignmentFilter(nextFilter: AssignmentFilter) {
    if (filterDisabled) return;
    setAssignmentFilter(nextFilter);
    setPendingAction(null);
    setEffectiveDate('');
    setEffectiveDateError(undefined);
    setEditingAssignment(null);
    setEditDraft(null);
    setEditErrors({});
    setEditCreateOutcomeUnknown(false);
    setRowError(null);
    setEditError(null);
  }

  function beginEdit(assignment: TaskAssignment) {
    resetFeedback();
    setPendingAction(null);
    const today = todayIsoDateInTimezone(assignment.timezone);
    const replacementStart =
      assignment.startDate && assignment.startDate > today ? assignment.startDate : today;
    setEditingAssignment(assignment);
    setEditDraft(scheduleDraftFromAssignment(assignment, replacementStart));
    setEditErrors({});
    window.requestAnimationFrame(() => {
      document.getElementById(`edit-assignment-${assignment.assignmentId}`)?.focus();
    });
  }

  function cancelEdit(restoreFocus = true) {
    const assignmentId = editingAssignment?.assignmentId;
    setEditingAssignment(null);
    setEditDraft(null);
    setEditErrors({});
    setEditError(null);
    setEditCreateOutcomeUnknown(false);
    if (restoreFocus && assignmentId) {
      window.requestAnimationFrame(() => {
        document.getElementById(`edit-schedule-${assignmentId}`)?.focus();
      });
    }
  }

  function cancelPending() {
    const current = pendingAction;
    setPendingAction(null);
    setEffectiveDateError(undefined);
    if (current) {
      window.requestAnimationFrame(() => {
        document.getElementById(`${current.kind}-assignment-${current.assignmentId}`)?.focus();
      });
    }
  }

  async function handleEditSubmit(event: FormEvent) {
    event.preventDefault();
    if (!editingAssignment || !editDraft || actionBusy || editCreateOutcomeUnknown) return;

    const errors = validateAssignmentSchedule(editDraft);
    setEditErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirstEditError();
      return;
    }

    const replacementDate = replacementEffectiveDate(editDraft);
    if (!replacementDate) {
      setEditErrors({ oneTimeAt: 'Pick the replacement date and time.' });
      focusFirstEditError();
      return;
    }
    const earliestReplacementDate = todayIsoDateInTimezone(editingAssignment.timezone);
    if (replacementDate < earliestReplacementDate) {
      setEditErrors({
        [editDraft.scheduleType === 'ONE_TIME' ? 'oneTimeAt' : 'startDate']:
          `Choose ${earliestReplacementDate} or later so earlier schedule history is preserved.`,
      });
      focusFirstEditError();
      return;
    }

    resetFeedback();
    let replacement: TaskAssignment;
    try {
      replacement = await replacementCreateMutation.mutateAsync(
        assignmentInputFromDraft(editingAssignment.taskId, userId, editDraft),
      );
    } catch (error) {
      setEditError(error);
      const outcomeUnknown = !hasGraphqlErrorResponse(error);
      setEditCreateOutcomeUnknown(outcomeUnknown);
      if (outcomeUnknown) {
        void assignmentsQuery.refetch();
        window.requestAnimationFrame(() => {
          document.getElementById(`cancel-edit-${editingAssignment.assignmentId}`)?.focus();
        });
      }
      return;
    }

    try {
      await replacementEndMutation.mutateAsync({
        userId,
        assignmentId: editingAssignment.assignmentId,
        effectiveDate: replacementDate,
      });
      setSuccessMessage(replacementCompletedMessage(editingAssignment, replacementDate, false));
      cancelEdit(false);
      focusAssignmentStatus();
    } catch (error) {
      // Creation uses a new UUID and must not be retried automatically. Keep both visible and
      // provide a retry for only the second, idempotent shortening step.
      const unfinished = {
        original: editingAssignment,
        replacement,
        effectiveDate: replacementDate,
        errorMessage: gqlErrorMessage(error),
      };
      setUnfinishedReplacement(unfinished);
      persistUnfinishedReplacement(supporterId, userId, unfinished);
      cancelEdit(false);
      focusReplacementWarning();
    }
  }

  async function finishReplacement() {
    if (!unfinishedReplacement || actionBusy) return;
    resetFeedback();
    try {
      await replacementEndMutation.mutateAsync({
        userId,
        assignmentId: unfinishedReplacement.original.assignmentId,
        effectiveDate: unfinishedReplacement.effectiveDate,
      });
      setSuccessMessage(
        replacementCompletedMessage(
          unfinishedReplacement.original,
          unfinishedReplacement.effectiveDate,
          true,
        ),
      );
      setUnfinishedReplacement(null);
      clearUnfinishedReplacement(supporterId, userId);
      focusAssignmentStatus();
    } catch (error) {
      setUnfinishedReplacement((current) => {
        if (!current) return current;
        const updated = { ...current, errorMessage: gqlErrorMessage(error) };
        persistUnfinishedReplacement(supporterId, userId, updated);
        return updated;
      });
      focusReplacementWarning();
    }
  }

  async function confirmPending(assignment: TaskAssignment) {
    if (!pendingAction || actionBusy) return;
    if (pendingAction.kind === 'end') {
      const nextError = validateEffectiveEndDate(assignment, effectiveDate);
      setEffectiveDateError(nextError);
      if (nextError) return;
    }
    resetFeedback();
    try {
      if (pendingAction.kind === 'stop') {
        await stopMutation.mutateAsync({ userId, assignmentId: assignment.assignmentId });
        setSuccessMessage(
          'Assignment stopped. Existing task instances remain in the calendar. The schedule is now under Ended or stopped.',
        );
      } else {
        const updated = await endMutation.mutateAsync({
          userId,
          assignmentId: assignment.assignmentId,
          effectiveDate,
        });
        setSuccessMessage(
          updated.active && updated.endDate
            ? `Schedule shortened through ${updated.endDate}. Existing task instances remain.`
            : 'Assignment ended. Existing task instances remain in the calendar. The schedule is now under Ended or stopped.',
        );
      }
      if (
        unfinishedReplacement &&
        pendingAction.kind === 'stop' &&
        (assignment.assignmentId === unfinishedReplacement.original.assignmentId ||
          assignment.assignmentId === unfinishedReplacement.replacement.assignmentId)
      ) {
        setUnfinishedReplacement(null);
        clearUnfinishedReplacement(supporterId, userId);
      }
      setPendingAction(null);
      focusAssignmentStatus();
    } catch (error) {
      setRowError({ assignmentId: assignment.assignmentId, error });
    }
  }

  return (
    <div id="assignments" className={styles.assignmentAnchor}>
      <Panel
        title="Existing assignments"
        description={`Review and manage every schedule rule for ${displayName}. Task instances already created remain after a rule is shortened or stopped.`}
        icon={<CalendarClock size={16} />}
      >
        {assignmentsQuery.isLoading ? (
          <div className={styles.assignmentLoading}>
            <Spinner label="Loading assignments…" />
          </div>
        ) : assignmentsQuery.isError ? (
          <div className={styles.assignmentError}>
            <Alert variant="error" title="Could not load assignments">
              {gqlErrorMessage(assignmentsQuery.error)} You can manage this schedule only while you
              actively support this user.
            </Alert>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} />}
              onClick={() => assignmentsQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : assignments.length === 0 ? (
          <>
            <EmptyState
              icon={<CalendarClock size={30} />}
              title="No assignments yet"
              description="Choose one of your task templates and schedule it for this user."
            />
            <div className={styles.assignmentEmptyAction}>
              <Button
                size="sm"
                icon={<ListPlus size={14} />}
                onClick={() => navigate(`/support/tasks?assignTo=${encodeURIComponent(userId)}`)}
              >
                Assign a task
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.assignmentFilterToolbar}>
              <div className={styles.assignmentFilterControl}>
                <Select
                  label="Show assignments"
                  value={assignmentFilter}
                  disabled={filterDisabled}
                  options={[
                    {
                      value: 'ACTIVE',
                      label: `Active schedules (${activeAssignmentCount})`,
                    },
                    {
                      value: 'ENDED_OR_STOPPED',
                      label: `Ended or stopped (${endedOrStoppedAssignmentCount})`,
                    },
                    { value: 'ALL', label: `All schedules (${assignments.length})` },
                  ]}
                  hint={
                    editingAssignment || pendingAction
                      ? 'Finish or cancel the open schedule action before changing this filter.'
                      : 'Active reflects the backend schedule state. A completed schedule window can remain active until it is stopped.'
                  }
                  onChange={(event) =>
                    changeAssignmentFilter(event.target.value as AssignmentFilter)
                  }
                />
              </div>
              <p className={styles.assignmentFilterSummary} aria-live="polite">
                Showing {filteredAssignments.length} of {assignments.length}{' '}
                {assignments.length === 1 ? 'schedule' : 'schedules'}.
              </p>
            </div>

            {ownedTasksQuery.isError && (
              <div className={styles.assignmentNotice}>
                <Alert variant="warning" title="Template details are unavailable">
                  Assignments are still manageable, but editing is disabled until your task
                  templates can be loaded.
                </Alert>
              </div>
            )}

            {successMessage && (
              <div
                id="assignment-status"
                className={styles.assignmentNotice}
                aria-live="polite"
                tabIndex={-1}
              >
                <Alert variant="success" title="Schedule updated">
                  {successMessage}
                </Alert>
              </div>
            )}

            {unfinishedReplacement && (
              <div className={styles.assignmentNotice}>
                <Alert variant="warning" title="Replacement needs one more step">
                  The replacement assignment{' '}
                  <IdCell id={unfinishedReplacement.replacement.assignmentId} /> was created, but
                  the previous rule could not be ended: {unfinishedReplacement.errorMessage} Both
                  may currently produce scheduled occurrences.
                  <div className={styles.alertActions}>
                    <Button
                      id="finish-replacement"
                      size="sm"
                      variant="secondary"
                      icon={<RefreshCw size={14} />}
                      loading={replacementEndMutation.isPending}
                      disabled={actionBusy}
                      onClick={finishReplacement}
                    >
                      Finish replacement
                    </Button>
                  </div>
                </Alert>
              </div>
            )}

            {filteredAssignments.length === 0 ? (
              <>
                <EmptyState
                  icon={
                    assignmentFilter === 'ACTIVE' ? (
                      <CalendarClock size={30} />
                    ) : (
                      <CalendarOff size={30} />
                    )
                  }
                  title={
                    assignmentFilter === 'ACTIVE'
                      ? 'No active schedules'
                      : 'No ended or stopped schedules'
                  }
                  description={
                    assignmentFilter === 'ACTIVE'
                      ? 'Choose one of your task templates and schedule it for this user, or select another filter to review schedule history.'
                      : 'Schedules that are ended or stopped will appear here.'
                  }
                />
                {assignmentFilter === 'ACTIVE' && (
                  <div className={styles.assignmentEmptyAction}>
                    <Button
                      size="sm"
                      icon={<ListPlus size={14} />}
                      onClick={() =>
                        navigate(`/support/tasks?assignTo=${encodeURIComponent(userId)}`)
                      }
                    >
                      Assign a task
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.assignmentList}>
                {filteredAssignments.map((assignment) => {
                  const isPendingHere = pendingAction?.assignmentId === assignment.assignmentId;
                  const isEditing = editingAssignment?.assignmentId === assignment.assignmentId;
                  const title = taskTitles.get(assignment.taskId);
                  const ownsTemplate = ownedTaskIds.has(assignment.taskId);
                  const pastCappedRule =
                    assignment.active &&
                    assignment.scheduleType === 'RECURRING' &&
                    Boolean(assignment.endDate) &&
                    assignment.endDate! < todayIsoDateInTimezone(assignment.timezone);
                  const recurrenceCanBeEdited = hasSimplePortalRecurrence(assignment);
                  const canEdit = ownsTemplate && !pastCappedRule && recurrenceCanBeEdited;
                  const isUnfinishedOriginal =
                    unfinishedReplacement?.original.assignmentId === assignment.assignmentId;
                  const scheduleDescription = describeSchedule(assignment);
                  const accessibleAssignmentName = `${title ?? assignment.taskId}, ${scheduleDescription}, assignment ${assignment.assignmentId}`;
                  const anotherRowHasOpenAction = Boolean(
                    (editingAssignment && !isEditing) || (pendingAction && !isPendingHere),
                  );

                  return (
                    <article
                      key={assignment.assignmentId}
                      className={`${styles.assignmentRow} ${assignment.active ? '' : styles.assignmentEnded}`}
                      aria-label={accessibleAssignmentName}
                    >
                      <div className={styles.assignmentBody}>
                        <h3
                          id={`assignment-title-${assignment.assignmentId}`}
                          className={styles.assignmentTaskTitle}
                        >
                          {title ?? 'Task template'}
                        </h3>
                        <span className={styles.assignmentSchedule}>{scheduleDescription}</span>
                        {assignment.active && ownsTemplate && !recurrenceCanBeEdited && (
                          <p className={styles.assignmentRuleHelp}>
                            This rule uses advanced recurrence options. Create a new schedule, then
                            return here to end this rule.
                          </p>
                        )}
                        <div className={styles.assignmentMeta}>
                          {assignment.active ? (
                            <Badge tone={pastCappedRule ? 'neutral' : 'success'}>
                              {pastCappedRule ? 'Past rule' : 'Active rule'}
                            </Badge>
                          ) : (
                            <Badge tone="neutral">Ended or stopped</Badge>
                          )}
                          <Badge
                            tone={assignment.scheduleType === 'RECURRING' ? 'info' : 'neutral'}
                          >
                            {assignment.scheduleType === 'RECURRING' ? 'Recurring' : 'One-time'}
                          </Badge>
                          {ownsTemplate && <Badge tone="info">Your template</Badge>}
                          <span>Assigned {formatDate(assignment.assignedAt)}</span>
                          {!assignment.active && assignment.endedAt && (
                            <span>Ended/stopped {formatDate(assignment.endedAt)}</span>
                          )}
                        </div>
                        <dl className={styles.assignmentIds}>
                          <div>
                            <dt>Task</dt>
                            <dd>
                              <IdCell id={assignment.taskId} />
                            </dd>
                          </div>
                          <div>
                            <dt>Assignment</dt>
                            <dd>
                              <IdCell id={assignment.assignmentId} />
                            </dd>
                          </div>
                          {assignment.assignedBy && (
                            <div>
                              <dt>Assigned by</dt>
                              <dd>
                                <IdCell id={assignment.assignedBy} />
                              </dd>
                            </div>
                          )}
                        </dl>

                        {rowError?.assignmentId === assignment.assignmentId && (
                          <Alert variant="error" title="Could not update this assignment">
                            {gqlErrorMessage(rowError.error)}
                          </Alert>
                        )}
                      </div>

                      {assignment.active && !isPendingHere && !isEditing && (
                        <div className={styles.assignmentActions}>
                          {canEdit && (
                            <Button
                              id={`edit-schedule-${assignment.assignmentId}`}
                              size="sm"
                              variant="secondary"
                              icon={<Pencil size={14} />}
                              disabled={
                                actionBusy ||
                                anotherRowHasOpenAction ||
                                Boolean(unfinishedReplacement)
                              }
                              aria-label={`Edit schedule for ${accessibleAssignmentName}`}
                              onClick={() => beginEdit(assignment)}
                            >
                              Edit schedule
                            </Button>
                          )}
                          {ownsTemplate && !recurrenceCanBeEdited && (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<ListPlus size={14} />}
                              disabled={
                                actionBusy ||
                                anotherRowHasOpenAction ||
                                Boolean(unfinishedReplacement)
                              }
                              aria-label={`Create a new schedule for ${accessibleAssignmentName}`}
                              title="This advanced recurrence rule cannot be edited inline. Create a new schedule, then return here to end this one."
                              onClick={() =>
                                navigate(
                                  `/support/tasks/${encodeURIComponent(assignment.taskId)}?assignTo=${encodeURIComponent(userId)}#assignments`,
                                )
                              }
                            >
                              Create new schedule
                            </Button>
                          )}
                          {assignment.scheduleType === 'RECURRING' &&
                            !pastCappedRule &&
                            !isUnfinishedOriginal && (
                              <Button
                                id={`end-assignment-${assignment.assignmentId}`}
                                size="sm"
                                variant="secondary"
                                icon={<CalendarOff size={14} />}
                                disabled={actionBusy || anotherRowHasOpenAction}
                                aria-label={`End ${accessibleAssignmentName} from a date`}
                                onClick={() => {
                                  resetFeedback();
                                  setEditingAssignment(null);
                                  const today = todayIsoDateInTimezone(assignment.timezone);
                                  setEffectiveDate(
                                    assignment.endDate && assignment.endDate < today
                                      ? assignment.endDate
                                      : today,
                                  );
                                  setEffectiveDateError(undefined);
                                  setPendingAction({
                                    assignmentId: assignment.assignmentId,
                                    kind: 'end',
                                  });
                                  window.requestAnimationFrame(() => {
                                    document
                                      .getElementById(`end-date-${assignment.assignmentId}`)
                                      ?.focus();
                                  });
                                }}
                              >
                                End from date…
                              </Button>
                            )}
                          <Button
                            id={`stop-assignment-${assignment.assignmentId}`}
                            size="sm"
                            variant="ghost"
                            icon={<OctagonX size={14} />}
                            disabled={actionBusy || anotherRowHasOpenAction}
                            aria-label={`Stop ${accessibleAssignmentName}`}
                            onClick={() => {
                              resetFeedback();
                              setEditingAssignment(null);
                              setPendingAction({
                                assignmentId: assignment.assignmentId,
                                kind: 'stop',
                              });
                              window.requestAnimationFrame(() => {
                                document
                                  .getElementById(`confirm-stop-${assignment.assignmentId}`)
                                  ?.focus();
                              });
                            }}
                          >
                            Stop now
                          </Button>
                        </div>
                      )}

                      {isPendingHere && pendingAction.kind === 'stop' && (
                        <div className={styles.inlineConfirm}>
                          <span className={styles.inlineConfirmLabel}>
                            Stop immediately? All virtual occurrences disappear, while task
                            instances already created remain in the calendar.
                          </span>
                          <Button
                            id={`confirm-stop-${assignment.assignmentId}`}
                            size="sm"
                            variant="danger"
                            loading={stopMutation.isPending}
                            aria-label={`Confirm stop for ${accessibleAssignmentName}`}
                            onClick={() => confirmPending(assignment)}
                          >
                            Stop assignment
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={actionBusy}
                            aria-label={`Cancel stopping ${accessibleAssignmentName}`}
                            onClick={cancelPending}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}

                      {isPendingHere && pendingAction.kind === 'end' && (
                        <div className={styles.inlineConfirm}>
                          <TextField
                            id={`end-date-${assignment.assignmentId}`}
                            label={`End from date (${assignment.timezone})`}
                            type="date"
                            value={effectiveDate}
                            max={assignment.endDate ?? undefined}
                            error={effectiveDateError}
                            disabled={endMutation.isPending}
                            hint="Virtual occurrences on and after this local date are removed. Existing task instances remain."
                            onChange={(event) => {
                              const nextDate = event.target.value;
                              setEffectiveDate(nextDate);
                              setEffectiveDateError(validateEffectiveEndDate(assignment, nextDate));
                            }}
                          />
                          <Button
                            size="sm"
                            variant="danger"
                            loading={endMutation.isPending}
                            disabled={!effectiveDate || Boolean(effectiveDateError)}
                            aria-label={`Confirm end date for ${accessibleAssignmentName}`}
                            onClick={() => confirmPending(assignment)}
                          >
                            End schedule
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={actionBusy}
                            aria-label={`Cancel ending ${accessibleAssignmentName}`}
                            onClick={cancelPending}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}

                      {isEditing && editDraft && (
                        <form
                          id={`edit-form-${assignment.assignmentId}`}
                          className={`${adminStyles.panelForm} ${styles.assignmentEditForm}`}
                          onSubmit={handleEditSubmit}
                          noValidate
                        >
                          <div>
                            <h4
                              id={`edit-assignment-${assignment.assignmentId}`}
                              className={styles.assignmentEditTitle}
                              tabIndex={-1}
                            >
                              Replace this schedule
                            </h4>
                            <p className={styles.assignmentEditHelp}>
                              Saving creates a new assignment first, then ends this rule before the
                              replacement starts.{' '}
                              {assignment.scheduleType === 'RECURRING'
                                ? 'Earlier recurring occurrences and existing task instances are preserved.'
                                : 'Any task instance already created from the old one-time assignment remains.'}
                            </p>
                          </div>
                          <AssignmentScheduleFields
                            idPrefix={`edit-${assignment.assignmentId}`}
                            draft={editDraft}
                            errors={editErrors}
                            disabled={actionBusy}
                            recurringStartLabel="Changes effective"
                            recurringStartHint="The replacement starts on this local date; the old rule ends the day before."
                            minimumDate={todayIsoDateInTimezone(assignment.timezone)}
                            onChange={setEditDraft}
                          />
                          {editError != null && (
                            <Alert
                              variant="error"
                              title={
                                editCreateOutcomeUnknown
                                  ? 'Could not confirm whether the replacement was created'
                                  : 'Could not create the replacement'
                              }
                            >
                              {gqlErrorMessage(editError)}{' '}
                              {editCreateOutcomeUnknown
                                ? 'The assignment list is being refreshed. Cancel this editor and review active schedules before trying again so you do not create a duplicate.'
                                : 'The existing schedule was not changed.'}
                            </Alert>
                          )}
                          <div className={adminStyles.formActions}>
                            <Button
                              type="submit"
                              icon={<Save size={14} />}
                              loading={
                                replacementCreateMutation.isPending ||
                                replacementEndMutation.isPending
                              }
                              disabled={editCreateOutcomeUnknown}
                            >
                              Save replacement
                            </Button>
                            <Button
                              id={`cancel-edit-${assignment.assignmentId}`}
                              variant="ghost"
                              disabled={actionBusy}
                              onClick={() => cancelEdit()}
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

/** The inline editor only rewrites the simple FREQ(+INTERVAL) rules this portal creates. */
function hasSimplePortalRecurrence(assignment: TaskAssignment): boolean {
  if (assignment.scheduleType === 'ONE_TIME') return true;
  if (!assignment.scheduleRule) return false;
  const parts = assignment.scheduleRule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter(Boolean);
  const keys = parts.map((part) => part.split('=')[0]?.toUpperCase());
  const parsed = parseRrule(assignment.scheduleRule);
  return Boolean(parsed.frequency) && keys.every((key) => key === 'FREQ' || key === 'INTERVAL');
}

function replacementCompletedMessage(
  original: TaskAssignment,
  effectiveDate: string,
  retry: boolean,
): string {
  const prefix = retry ? 'Replacement completed.' : 'Replacement schedule created.';
  return original.scheduleType === 'RECURRING'
    ? `${prefix} The previous rule now ends before ${effectiveDate}.`
    : `${prefix} The previous one-time assignment was ended.`;
}

function validateEffectiveEndDate(
  assignment: TaskAssignment,
  effectiveDate: string,
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return 'Choose a valid end date.';
  if (assignment.endDate && effectiveDate > assignment.endDate) {
    return `Choose ${assignment.endDate} or earlier. This schedule already ends on that date.`;
  }
  return undefined;
}

function replacementStorageKey(supporterId: string, userId: string): string {
  return `canplan:unfinished-assignment-replacement:${supporterId}:${userId}`;
}

function persistUnfinishedReplacement(
  supporterId: string,
  userId: string,
  unfinished: UnfinishedReplacement,
) {
  if (!supporterId || !userId) return;
  try {
    window.sessionStorage.setItem(
      replacementStorageKey(supporterId, userId),
      JSON.stringify(unfinished),
    );
  } catch {
    // Session storage may be blocked; the in-memory recovery action still remains available.
  }
}

function readUnfinishedReplacement(
  supporterId: string,
  userId: string,
): UnfinishedReplacement | null {
  if (!supporterId || !userId) return null;
  try {
    const stored = window.sessionStorage.getItem(replacementStorageKey(supporterId, userId));
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<UnfinishedReplacement> & { error?: unknown };
    const { original, replacement, effectiveDate } = parsed;
    if (!original?.assignmentId || !replacement?.assignmentId || !effectiveDate) {
      clearUnfinishedReplacement(supporterId, userId);
      return null;
    }
    const legacyErrorMessage =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error != null
          ? gqlErrorMessage(parsed.error)
          : undefined;
    return {
      original,
      replacement,
      effectiveDate,
      errorMessage:
        parsed.errorMessage?.trim() ||
        legacyErrorMessage ||
        'The previous schedule could not be ended.',
    };
  } catch {
    clearUnfinishedReplacement(supporterId, userId);
    return null;
  }
}

function clearUnfinishedReplacement(supporterId: string, userId: string) {
  if (!supporterId || !userId) return;
  try {
    window.sessionStorage.removeItem(replacementStorageKey(supporterId, userId));
  } catch {
    // Session storage may be blocked; there is nothing else to clear.
  }
}
