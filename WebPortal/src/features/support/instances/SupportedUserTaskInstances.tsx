import { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, FileText, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TaskInstance, TaskInstanceStatus } from '../../../api/apiTypes';
import { useUserCalendar, useUserTaskInstances } from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Spinner } from '../../../components/ui/Spinner';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import { formatDate, IdCell, StatusBadge } from '../../admin/components/display';
import { validateReportRange } from '../reports/reportFormat';
import {
  defaultInstanceHistoryRange,
  formatDuration,
  INSTANCE_STATUS_OPTIONS,
  scheduledDateTimeLabel,
  validateInstanceHistoryRange,
} from './instanceFormat';
import styles from './instances.module.css';

interface SupportedUserTaskInstancesProps {
  userId: string;
  displayName: string;
}

/** Materialized task-instance history. Virtual calendar occurrences deliberately do not appear. */
export function SupportedUserTaskInstances({
  userId,
  displayName,
}: SupportedUserTaskInstancesProps) {
  const initialRange = useMemo(defaultInstanceHistoryRange, []);
  const [startDate, setStartDate] = useState(initialRange.startDate);
  const [endDate, setEndDate] = useState(initialRange.endDate);
  const [appliedRange, setAppliedRange] = useState(initialRange);
  const [status, setStatus] = useState<'ALL' | TaskInstanceStatus>('ALL');
  const [rangeError, setRangeError] = useState<string | null>(null);

  const instancesQuery = useUserTaskInstances(userId, appliedRange.startDate, appliedRange.endDate);
  const allInstances = instancesQuery.data ?? [];
  const titleRange = useMemo(() => {
    if (allInstances.length === 0) return null;
    const dates = allInstances.map((instance) => instance.scheduledDate).sort();
    return { startDate: dates[0], endDate: dates[dates.length - 1] };
  }, [allInstances]);
  // TaskInstance deliberately has no title. The delegated calendar view is the authoritative
  // title-bearing read, including when another supporter owns the assigned template. Limit it
  // to the actual instance dates so an empty or sparse history does not expand needless virtuals.
  const titlesQuery = useUserCalendar(
    titleRange ? userId : undefined,
    titleRange?.startDate ?? '',
    titleRange?.endDate ?? '',
  );
  const titleByInstanceId = useMemo(
    () =>
      new Map(
        (titlesQuery.data?.items ?? [])
          .filter((view) => view.instanceId)
          .map((view) => [view.instanceId as string, view.title.trim()] as const),
      ),
    [titlesQuery.data],
  );
  const visibleInstances = useMemo(
    () =>
      allInstances
        .filter((instance) => status === 'ALL' || instance.status === status)
        .slice()
        .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)),
    [allInstances, status],
  );

  function applyDateRange(event: FormEvent) {
    event.preventDefault();
    const error = validateInstanceHistoryRange(startDate, endDate);
    setRangeError(error);
    if (!error) setAppliedRange({ startDate, endDate });
  }

  const dateRangeChanged = startDate !== appliedRange.startDate || endDate !== appliedRange.endDate;
  const reportRangeError = validateReportRange(startDate, endDate);
  const reportHref =
    `/support/reports?userId=${encodeURIComponent(userId)}` +
    `&from=${encodeURIComponent(startDate)}` +
    `&to=${encodeURIComponent(endDate)}#generate-report`;

  return (
    <div id="task-instances" className={styles.sectionAnchor}>
      <Panel
        title="Task completion history"
        description={`Review ${displayName}'s materialized task instances and open one to inspect each step.`}
        icon={<CheckCircle2 size={16} />}
      >
        <form className={styles.filterForm} onSubmit={applyDateRange} noValidate>
          <div className={styles.filterFields}>
            <TextField
              type="date"
              label="From"
              value={startDate}
              max={endDate || undefined}
              error={rangeError ?? undefined}
              onChange={(event) => {
                setStartDate(event.target.value);
                if (rangeError) setRangeError(null);
              }}
            />
            <TextField
              type="date"
              label="To"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => {
                setEndDate(event.target.value);
                if (rangeError) setRangeError(null);
              }}
            />
            <Select
              label="Status"
              value={status}
              options={INSTANCE_STATUS_OPTIONS}
              onChange={(event) => setStatus(event.target.value as 'ALL' | TaskInstanceStatus)}
            />
          </div>
          <div className={styles.filterActions}>
            <Button type="submit" size="sm" disabled={!dateRangeChanged && !rangeError}>
              Apply dates
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} />}
              loading={instancesQuery.isFetching || titlesQuery.isFetching}
              onClick={() => {
                instancesQuery.refetch();
                if (titleRange) titlesQuery.refetch();
              }}
            >
              Refresh
            </Button>
            {reportRangeError ? (
              <span
                className={`${styles.reportLink} ${styles.reportLinkDisabled}`}
                role="link"
                tabIndex={0}
                aria-disabled="true"
                aria-describedby="task-history-report-range-error"
              >
                <FileText size={14} aria-hidden="true" />
                Generate report for selected dates
              </span>
            ) : (
              <Link className={styles.reportLink} to={reportHref}>
                <FileText size={14} aria-hidden="true" />
                Generate report for selected dates
              </Link>
            )}
            {reportRangeError && (
              <span id="task-history-report-range-error" className={styles.reportLinkError}>
                Report unavailable: {reportRangeError}
              </span>
            )}
          </div>
        </form>

        <p className={styles.resultSummary} aria-live="polite">
          {instancesQuery.isLoading
            ? 'Loading task instances…'
            : `Showing ${visibleInstances.length} of ${allInstances.length} materialized task ${
                allInstances.length === 1 ? 'instance' : 'instances'
              } from ${appliedRange.startDate} through ${appliedRange.endDate}.`}
        </p>

        {instancesQuery.isLoading ? (
          <div className={styles.loadingBlock}>
            <Spinner label="Loading task instances…" />
          </div>
        ) : instancesQuery.isError ? (
          <div className={styles.errorBlock}>
            <Alert variant="error" title="Could not load task completion history">
              {gqlErrorMessage(instancesQuery.error)} You can only view this history while you
              actively support this user.
            </Alert>
            <Button size="sm" variant="secondary" onClick={() => instancesQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : visibleInstances.length === 0 ? (
          <EmptyState
            title={
              allInstances.length === 0
                ? 'No task instances in this date range'
                : 'No matching task instances'
            }
            description={
              allInstances.length === 0
                ? 'Only tasks the user has started, completed, skipped, or otherwise materialized are shown here. Future virtual schedule entries remain in the calendar.'
                : 'Choose another status to see the other task instances in this date range.'
            }
          />
        ) : (
          <div className={styles.instanceList}>
            {visibleInstances.map((instance) => (
              <TaskInstanceRow
                key={instance.instanceId}
                userId={userId}
                instance={instance}
                title={titleByInstanceId.get(instance.instanceId)}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function TaskInstanceRow({
  userId,
  instance,
  title: resolvedTitle,
}: {
  userId: string;
  instance: TaskInstance;
  title?: string;
}) {
  const title = resolvedTitle || `Task ${instance.taskId}`;
  const href = `/support/users/${encodeURIComponent(userId)}/task-instances/${encodeURIComponent(
    instance.instanceId,
  )}`;
  const scheduled = scheduledDateTimeLabel(
    instance.scheduledFor,
    instance.timezone,
    instance.scheduledDate,
    instance.scheduledTime,
  );

  return (
    <article className={styles.instanceCard}>
      <div className={styles.instanceCardHead}>
        <div className={styles.instanceTitleBlock}>
          <Link
            className={styles.instanceTitle}
            to={href}
            aria-label={`View details for ${title}, scheduled ${scheduled}`}
          >
            {title}
          </Link>
          <span className={styles.scheduledText}>{scheduled}</span>
        </div>
        <StatusBadge status={instance.status} />
      </div>

      <dl className={styles.instanceFacts}>
        <Fact label="Started" value={formatDate(instance.startedAt)} />
        <Fact
          label="Completed"
          value={instance.completedAt ? formatDate(instance.completedAt) : 'Not completed'}
        />
        <Fact label="Active time" value={formatDuration(instance.activeDurationSeconds)} />
        <Fact label="Exception" value={instance.isException ? 'Yes' : 'No'} />
      </dl>

      <div className={styles.instanceFooter}>
        <div className={styles.compactIds}>
          <span>Instance</span>
          <IdCell id={instance.instanceId} />
        </div>
        <Link className={styles.detailLink} to={href}>
          View completion details <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
