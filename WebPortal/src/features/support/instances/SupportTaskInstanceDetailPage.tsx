import { ArrowLeft, CheckCircle2, Clock3, ListChecks, RefreshCw } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  useUserCalendar,
  useUserProfile,
  useUserTaskInstance,
  useUserTaskInstanceSteps,
} from '../../../api/supportHooks';
import type { TaskInstanceStep } from '../../../api/apiTypes';
import { gqlErrorMessage } from '../../../api/graphqlError';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { MetricStrip } from '../../admin/components/MetricStrip';
import { Panel } from '../../admin/components/Panel';
import { formatDate, IdCell, StatusBadge } from '../../admin/components/display';
import { formatDuration, scheduledDateTimeLabel } from './instanceFormat';
import adminStyles from '../../admin/admin.module.css';
import styles from './instances.module.css';

/** Read-only completion and timing detail for one supported user's materialized instance. */
export default function SupportTaskInstanceDetailPage() {
  const { userId = '', instanceId = '' } = useParams<{
    userId: string;
    instanceId: string;
  }>();
  const profileQuery = useUserProfile(userId);
  const instanceQuery = useUserTaskInstance(userId, instanceId);
  const instance = instanceQuery.data;
  const stepsQuery = useUserTaskInstanceSteps(instance ? userId : undefined, instanceId);
  const titleQuery = useUserCalendar(
    instance ? userId : undefined,
    instance?.scheduledDate ?? '',
    instance?.scheduledDate ?? '',
  );
  const steps = stepsQuery.data ?? [];
  const completedSteps = steps.filter((step) => step.completed).length;
  const displayName =
    profileQuery.data?.displayName || profileQuery.data?.email || userId || 'the supported user';
  const taskTitle =
    titleQuery.data?.items.find((view) => view.instanceId === instanceId)?.title.trim() ||
    (instance ? `Task ${instance.taskId}` : 'Task instance');
  const returnTo = `/support/users/${encodeURIComponent(userId)}#task-instances`;

  function refetchDetails() {
    instanceQuery.refetch();
    stepsQuery.refetch();
    titleQuery.refetch();
  }

  return (
    <div>
      <Link to={returnTo} className={adminStyles.backLink}>
        <ArrowLeft size={15} /> Back to {displayName}'s task history
      </Link>

      {instanceQuery.isLoading ? (
        <div className={styles.pageLoading}>
          <Spinner label="Loading task-instance details…" />
        </div>
      ) : instanceQuery.isError ? (
        <div className={styles.errorBlock}>
          <Alert variant="error" title="Could not load this task instance">
            {gqlErrorMessage(instanceQuery.error)} Access requires an active support relationship
            with this user.
          </Alert>
          <Button size="sm" variant="secondary" onClick={() => instanceQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : !instance ? (
        <Alert variant="warning" title="Task instance not found">
          This materialized task instance does not exist for {displayName}. Virtual calendar
          occurrences do not have a completion-detail record until they are materialized.
        </Alert>
      ) : (
        <>
          <div className={adminStyles.pageHead}>
            <div className={styles.detailHeadingRow}>
              <div>
                <h1 className={adminStyles.pageTitle}>{taskTitle}</h1>
                <p className={adminStyles.pageSubtitle}>
                  Completion details for {displayName} · <IdCell id={instance.instanceId} />
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={14} />}
                loading={instanceQuery.isFetching || stepsQuery.isFetching || titleQuery.isFetching}
                onClick={refetchDetails}
              >
                Refresh details
              </Button>
            </div>
          </div>

          <MetricStrip
            metrics={[
              {
                label: 'Steps completed',
                value: stepsQuery.isLoading
                  ? 'Loading…'
                  : stepsQuery.isError
                    ? 'Unavailable'
                    : `${completedSteps}/${steps.length}`,
                icon: <CheckCircle2 size={18} />,
              },
              {
                label: 'Active time',
                value: formatDuration(instance.activeDurationSeconds),
                icon: <Clock3 size={18} />,
              },
              {
                label: 'Status',
                value: instance.status.replace(/_/g, ' '),
                icon: <ListChecks size={18} />,
              },
            ]}
          />

          <Panel
            title="Task instance"
            description="Stored lifecycle, schedule, timing, and identity fields for this occurrence."
          >
            <div className={adminStyles.detailGrid}>
              <Detail label="Status" value={<StatusBadge status={instance.status} />} />
              <Detail label="Exception" value={instance.isException ? 'Yes' : 'No'} />
              <Detail
                label="Scheduled"
                value={scheduledDateTimeLabel(
                  instance.scheduledFor,
                  instance.timezone,
                  instance.scheduledDate,
                  instance.scheduledTime,
                )}
              />
              <Detail label="Timezone" value={instance.timezone} />
              <Detail label="Started" value={formatDate(instance.startedAt)} />
              <Detail label="Completed" value={formatDate(instance.completedAt)} />
              <Detail label="Skipped" value={formatDate(instance.skippedAt)} />
              <Detail label="Cancelled" value={formatDate(instance.cancelledAt)} />
              <Detail
                label="Active duration"
                value={formatDuration(instance.activeDurationSeconds)}
              />
              <Detail label="Elapsed duration" value={formatDuration(instance.elapsedSeconds)} />
              <Detail
                label="Active step"
                value={instance.activeStepId ? <IdCell id={instance.activeStepId} /> : '—'}
              />
              <Detail
                label="Active step started"
                value={formatDate(instance.activeStepStartedAt)}
              />
              <Detail label="Created" value={formatDate(instance.createdAt)} />
              <Detail label="Updated" value={formatDate(instance.updatedAt)} />
              <Detail label="Instance id" value={<IdCell id={instance.instanceId} />} />
              <Detail label="Assignment id" value={<IdCell id={instance.assignmentId} />} />
              <Detail label="Task id" value={<IdCell id={instance.taskId} />} />
              <Detail label="User id" value={<IdCell id={instance.userId} />} />
            </div>
            <p className={styles.timingHelp}>
              Active duration counts recorded step activity and excludes paused or idle time. A
              currently running interval is added only when its timer closes. Elapsed duration is
              the wall-clock time from start through task completion and is only stored for
              completed instances. Overdue is derived when this page is read; it is not a stored
              completion state.
            </p>
          </Panel>

          <div className={styles.detailSectionGap} />

          <Panel
            title={
              stepsQuery.isSuccess
                ? `Step completion (${completedSteps}/${steps.length})`
                : 'Step completion'
            }
            description="The step snapshots captured when this task instance was started."
            icon={<ListChecks size={16} />}
          >
            {stepsQuery.isLoading ? (
              <div className={styles.loadingBlock}>
                <Spinner label="Loading step completion…" />
              </div>
            ) : stepsQuery.isError ? (
              <div className={styles.errorBlock}>
                <Alert variant="error" title="Could not load step completion">
                  {gqlErrorMessage(stepsQuery.error)}
                </Alert>
                <Button size="sm" variant="secondary" onClick={() => stepsQuery.refetch()}>
                  Try again
                </Button>
              </div>
            ) : steps.length === 0 ? (
              <EmptyState
                title="No step snapshots"
                description="This instance has no stored steps. It may come from a task template that had no steps when the user started it."
              />
            ) : (
              <ol className={styles.stepList}>
                {steps.map((step) => (
                  <CompletionStep key={step.stepId} step={step} />
                ))}
              </ol>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function CompletionStep({ step }: { step: TaskInstanceStep }) {
  return (
    <li className={styles.stepCard}>
      <span className={styles.stepNumber} aria-label={`Step ${step.order}`}>
        {step.order}
      </span>
      <div className={styles.stepBody}>
        <div className={styles.stepHead}>
          <p className={styles.stepText}>{step.text}</p>
          <Badge tone={step.completed ? 'success' : 'neutral'}>
            {step.completed ? 'Completed' : 'Not completed'}
          </Badge>
        </div>
        <dl className={styles.stepFacts}>
          <Fact label="Completed" value={formatDate(step.completedAt)} />
          <Fact label="First started" value={formatDate(step.firstStartedAt)} />
          <Fact label="Last started" value={formatDate(step.lastStartedAt)} />
          <Fact label="Active time" value={formatDuration(step.activeDurationSeconds)} />
        </dl>
        <div className={styles.stepId}>
          <span>Step id</span>
          <IdCell id={step.stepId} />
        </div>
      </div>
    </li>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={adminStyles.detailItem}>
      <span className={adminStyles.detailLabel}>{label}</span>
      <span className={adminStyles.detailValue}>{value}</span>
    </div>
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
