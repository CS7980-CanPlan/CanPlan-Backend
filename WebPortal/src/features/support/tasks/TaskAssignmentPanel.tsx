import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CalendarOff, OctagonX, Send, Users } from 'lucide-react';
import {
  useCreateTaskAssignment,
  useDeleteTaskAssignment,
  useEndTaskAssignment,
  useMyOrganizationUsers,
  useMySupportList,
  useUserAssignmentsAll,
} from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import type { CreateTaskAssignmentInput, TaskAssignment } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select, type SelectOption } from '../../../components/ui/Select';
import { Spinner } from '../../../components/ui/Spinner';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import { formatDate } from '../../admin/components/display';
import {
  browserTimezone,
  buildRrule,
  describeSchedule,
  todayIsoDate,
  type RecurrenceFrequency,
} from './taskSchedule';
import adminStyles from '../../admin/admin.module.css';
import styles from './tasks.module.css';

type ScheduleTypeChoice = 'ONE_TIME' | 'RECURRING';

/** Which assignment row currently shows an inline confirmation, and for which action. */
interface PendingAction {
  assignmentId: string;
  kind: 'stop' | 'end';
}

const FREQUENCY_OPTIONS: SelectOption[] = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
];

/**
 * Assignment workflow for one OWNED task template: create ONE_TIME / RECURRING schedule
 * rules for ACTIVE supported users, and review/stop/end the existing assignments.
 * Assignments are queried per target user (there is no by-task query), hence the separate
 * "review" user selector. There is also no update mutation — changing a schedule means
 * ending/stopping the old assignment and creating a new one.
 */
export function TaskAssignmentPanel({ taskId }: { taskId: string }) {
  const supportListQuery = useMySupportList();
  const orgUsersQuery = useMyOrganizationUsers();

  const createMutation = useCreateTaskAssignment();
  const endMutation = useEndTaskAssignment();
  const deleteMutation = useDeleteTaskAssignment();

  // ── Create-form state ────────────────────────────────────────────────────────
  const [targetUserId, setTargetUserId] = useState('');
  const [scheduleType, setScheduleType] = useState<ScheduleTypeChoice>('ONE_TIME');
  const [timezone, setTimezone] = useState(browserTimezone());
  const [oneTimeAt, setOneTimeAt] = useState('');
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('DAILY');
  const [interval, setIntervalValue] = useState('');
  const [startDate, setStartDate] = useState(todayIsoDate());
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [lastCreated, setLastCreated] = useState<TaskAssignment | null>(null);

  // ── Review state ─────────────────────────────────────────────────────────────
  const [reviewUserId, setReviewUserId] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(todayIsoDate());
  // Drains every page: the by-task filter below is only truthful over the COMPLETE list.
  const assignmentsQuery = useUserAssignmentsAll(reviewUserId || undefined);

  /** Only ACTIVE links may be assignment targets — REVOKED users are never listed. */
  const activeLinks = useMemo(
    () => (supportListQuery.data?.items ?? []).filter((link) => link.status === 'ACTIVE'),
    [supportListQuery.data],
  );

  /** userId → display name, resolved from the caller's organization roster. */
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
    ...activeLinks.map((link) => ({ value: link.primaryUserId, label: nameOf(link.primaryUserId) })),
  ];

  const taskAssignments = useMemo(
    () => (assignmentsQuery.data ?? []).filter((assignment) => assignment.taskId === taskId),
    [assignmentsQuery.data, taskId],
  );
  const activeAssignments = taskAssignments.filter((assignment) => assignment.active);
  const endedAssignments = taskAssignments.filter((assignment) => !assignment.active);

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (createMutation.isPending) return;

    const errors: Record<string, string> = {};
    const tz = timezone.trim();
    if (!targetUserId) errors.target = 'Choose who this task is assigned to.';
    if (!tz) errors.timezone = 'A timezone is required.';
    if (scheduleType === 'ONE_TIME') {
      if (!oneTimeAt) errors.oneTimeAt = 'Pick the date and time.';
    } else {
      if (!startDate) errors.startDate = 'A start date is required.';
      if (!startTime) errors.startTime = 'A start time is required.';
      if (interval !== '') {
        const parsed = Number(interval);
        if (!Number.isInteger(parsed) || parsed < 1) {
          errors.interval = 'Interval must be a positive whole number.';
        }
      }
      if (endDate && startDate && endDate < startDate) {
        errors.endDate = 'End date cannot be before the start date.';
      }
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // Exactly one schedule shape is sent — never fields from the other type, and never
    // assignedBy (the backend derives it from the caller and ignores any input value).
    const input: CreateTaskAssignmentInput =
      scheduleType === 'ONE_TIME'
        ? {
            taskId,
            userId: targetUserId,
            scheduleType: 'ONE_TIME',
            scheduledFor: oneTimeAt,
            timezone: tz,
          }
        : {
            taskId,
            userId: targetUserId,
            scheduleType: 'RECURRING',
            scheduleRule: buildRrule(frequency, interval === '' ? undefined : Number(interval)),
            startDate,
            startTime,
            ...(endDate ? { endDate } : {}),
            timezone: tz,
          };

    setLastCreated(null);
    createMutation.mutate(input, {
      onSuccess: (assignment) => {
        setLastCreated(assignment);
        setReviewUserId(assignment.userId);
        setOneTimeAt('');
      },
    });
  }

  function confirmPending(assignment: TaskAssignment) {
    if (!pendingAction) return;
    if (pendingAction.kind === 'stop') {
      deleteMutation.mutate(
        { userId: assignment.userId, assignmentId: assignment.assignmentId },
        { onSuccess: () => setPendingAction(null) },
      );
    } else {
      endMutation.mutate(
        {
          userId: assignment.userId,
          assignmentId: assignment.assignmentId,
          effectiveDate,
        },
        { onSuccess: () => setPendingAction(null) },
      );
    }
  }

  const supportListReady = !supportListQuery.isLoading && !supportListQuery.isError;

  return (
    <Panel
      title="Assignments"
      description="Schedule this template for people you actively support. Schedules cannot be edited in place — end or stop the old assignment and create a new one."
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
          {/* ── Create an assignment ────────────────────────────────────────── */}
          <form className={adminStyles.panelForm} onSubmit={handleCreate} noValidate>
            <div className={adminStyles.formRow}>
              <Select
                label="Assign to"
                required
                options={targetOptions}
                value={targetUserId}
                error={formErrors.target}
                disabled={createMutation.isPending}
                hint="Only people with an active support link are listed."
                onChange={(e) => setTargetUserId(e.target.value)}
              />
              <TextField
                label="Timezone"
                required
                value={timezone}
                error={formErrors.timezone}
                disabled={createMutation.isPending}
                hint='IANA name, e.g. "America/Toronto". The schedule is interpreted in it.'
                onChange={(e) => setTimezone(e.target.value)}
              />
            </div>

            <fieldset className={styles.scheduleFieldset} disabled={createMutation.isPending}>
              <legend className={styles.scheduleLegend}>Schedule type</legend>
              <div className={styles.radioRow}>
                <label className={styles.radioOption}>
                  <input
                    type="radio"
                    name={`schedule-type-${taskId}`}
                    value="ONE_TIME"
                    checked={scheduleType === 'ONE_TIME'}
                    onChange={() => setScheduleType('ONE_TIME')}
                  />
                  One-time
                </label>
                <label className={styles.radioOption}>
                  <input
                    type="radio"
                    name={`schedule-type-${taskId}`}
                    value="RECURRING"
                    checked={scheduleType === 'RECURRING'}
                    onChange={() => setScheduleType('RECURRING')}
                  />
                  Recurring
                </label>
              </div>
            </fieldset>

            {scheduleType === 'ONE_TIME' ? (
              <TextField
                label="Date and time"
                required
                type="datetime-local"
                value={oneTimeAt}
                error={formErrors.oneTimeAt}
                disabled={createMutation.isPending}
                hint="Local wall-clock time in the timezone above."
                onChange={(e) => setOneTimeAt(e.target.value)}
              />
            ) : (
              <>
                <div className={adminStyles.formRow}>
                  <Select
                    label="Frequency"
                    required
                    options={FREQUENCY_OPTIONS}
                    value={frequency}
                    disabled={createMutation.isPending}
                    onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
                  />
                  <TextField
                    label="Repeat every (optional)"
                    type="number"
                    min={1}
                    step={1}
                    value={interval}
                    error={formErrors.interval}
                    disabled={createMutation.isPending}
                    hint="e.g. 2 with Weekly = every 2 weeks. Leave blank for every occurrence."
                    onChange={(e) => setIntervalValue(e.target.value)}
                  />
                </div>
                <div className={adminStyles.formRow}>
                  <TextField
                    label="Start date"
                    required
                    type="date"
                    value={startDate}
                    error={formErrors.startDate}
                    disabled={createMutation.isPending}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                  <TextField
                    label="Start time"
                    required
                    type="time"
                    value={startTime}
                    error={formErrors.startTime}
                    disabled={createMutation.isPending}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <TextField
                  label="End date (optional)"
                  type="date"
                  min={startDate || undefined}
                  value={endDate}
                  error={formErrors.endDate}
                  disabled={createMutation.isPending}
                  hint="Leave blank for an open-ended schedule."
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </>
            )}

            {createMutation.isError && (
              <Alert variant="error" title="Could not create the assignment">
                {gqlErrorMessage(createMutation.error)}
              </Alert>
            )}
            {lastCreated && !createMutation.isError && (
              <Alert variant="success" title="Assignment created">
                {nameOf(lastCreated.userId)} — {describeSchedule(lastCreated)}
              </Alert>
            )}

            <div className={adminStyles.formActions}>
              <Button type="submit" icon={<Send size={15} />} loading={createMutation.isPending}>
                Assign task
              </Button>
            </div>
          </form>

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '1.25rem 0' }} />

          {/* ── Review / stop / end ─────────────────────────────────────────── */}
          <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.6rem' }}>Existing assignments</h3>
          <Select
            label="Show assignments for"
            options={[{ value: '', label: 'Select a person…' }, ...targetOptions.slice(1)]}
            value={reviewUserId}
            disabled={assignmentsQuery.isFetching && Boolean(reviewUserId)}
            hint="Assignments are stored per person, so pick whose schedule to review."
            onChange={(e) => {
              setReviewUserId(e.target.value);
              setPendingAction(null);
            }}
          />

          {!reviewUserId ? null : assignmentsQuery.isLoading ? (
            <div style={{ padding: '1.5rem', display: 'grid', placeItems: 'center' }}>
              <Spinner label="Loading assignments…" />
            </div>
          ) : assignmentsQuery.isError ? (
            <Alert variant="error" title="Could not load the assignments">
              {gqlErrorMessage(assignmentsQuery.error)}
            </Alert>
          ) : taskAssignments.length === 0 ? (
            <EmptyState
              icon={<CalendarClock size={30} />}
              title="No assignments of this task"
              description={`${nameOf(reviewUserId)} has no assignments referencing this template.`}
            />
          ) : (
            <>
              {(endMutation.isError || deleteMutation.isError) && (
                <div style={{ margin: '0.75rem 0' }}>
                  <Alert variant="error" title="Could not update the assignment">
                    {gqlErrorMessage(endMutation.error ?? deleteMutation.error)}
                  </Alert>
                </div>
              )}

              <div className={styles.assignmentList} style={{ marginTop: '0.75rem' }}>
                {[...activeAssignments, ...endedAssignments].map((assignment) => {
                  const isPendingHere = pendingAction?.assignmentId === assignment.assignmentId;
                  const actionBusy = endMutation.isPending || deleteMutation.isPending;
                  return (
                    <div
                      key={assignment.assignmentId}
                      className={`${styles.assignmentRow} ${assignment.active ? '' : styles.assignmentEnded}`}
                    >
                      <div className={styles.assignmentBody}>
                        <span className={styles.assignmentSchedule}>
                          {describeSchedule(assignment)}
                        </span>
                        <span className={styles.assignmentMeta}>
                          {assignment.active ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            <Badge tone="neutral">Ended</Badge>
                          )}
                          <Badge tone={assignment.scheduleType === 'RECURRING' ? 'info' : 'neutral'}>
                            {assignment.scheduleType === 'RECURRING' ? 'Recurring' : 'One-time'}
                          </Badge>
                          <span>Assigned {formatDate(assignment.assignedAt)}</span>
                          {!assignment.active && assignment.endedAt && (
                            <span>Ended {formatDate(assignment.endedAt)}</span>
                          )}
                        </span>

                        {isPendingHere && pendingAction?.kind === 'stop' && (
                          <div className={styles.inlineConfirm}>
                            <span className={styles.inlineConfirmLabel}>
                              Stop this assignment immediately? Future occurrences will no
                              longer appear.
                            </span>
                            <Button
                              size="sm"
                              variant="danger"
                              loading={deleteMutation.isPending}
                              onClick={() => confirmPending(assignment)}
                            >
                              Stop assignment
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={actionBusy}
                              onClick={() => setPendingAction(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        )}
                        {isPendingHere && pendingAction?.kind === 'end' && (
                          <div className={styles.inlineConfirm}>
                            <label className={styles.inlineConfirmLabel} htmlFor={`end-date-${assignment.assignmentId}`}>
                              End from (occurrences on/after this date are removed)
                            </label>
                            <input
                              id={`end-date-${assignment.assignmentId}`}
                              type="date"
                              className={styles.dateInput}
                              value={effectiveDate}
                              onChange={(e) => setEffectiveDate(e.target.value)}
                            />
                            <Button
                              size="sm"
                              variant="danger"
                              loading={endMutation.isPending}
                              disabled={!effectiveDate}
                              onClick={() => confirmPending(assignment)}
                            >
                              End assignment
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={actionBusy}
                              onClick={() => setPendingAction(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        )}
                      </div>

                      {assignment.active && !isPendingHere && (
                        <div className={styles.assignmentActions}>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<CalendarOff size={14} />}
                            disabled={actionBusy}
                            onClick={() => {
                              endMutation.reset();
                              deleteMutation.reset();
                              setEffectiveDate(todayIsoDate());
                              setPendingAction({ assignmentId: assignment.assignmentId, kind: 'end' });
                            }}
                          >
                            End from date…
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<OctagonX size={14} />}
                            disabled={actionBusy}
                            onClick={() => {
                              endMutation.reset();
                              deleteMutation.reset();
                              setPendingAction({ assignmentId: assignment.assignmentId, kind: 'stop' });
                            }}
                          >
                            Stop now
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

            </>
          )}
        </>
      )}
    </Panel>
  );
}
