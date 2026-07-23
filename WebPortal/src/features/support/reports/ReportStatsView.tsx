import type { ReactNode } from 'react';
import { Activity, CheckCircle2, Clock3, ListChecks } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReportStats } from '../../../api/apiTypes';
import { EmptyState } from '../../../components/ui/EmptyState';
import { MetricStrip } from '../../admin/components/MetricStrip';
import { IdCell } from '../../admin/components/display';
import { formatDuration } from '../instances/instanceFormat';
import { formatHour, formatPercent } from './reportFormat';
import styles from './reports.module.css';

interface ReportStatsViewProps {
  stats: ReportStats;
  userId: string;
}

/** Render every deterministic metric returned by buildReportStats. */
export function ReportStatsView({ stats, userId }: ReportStatsViewProps) {
  const completion = stats.completion;

  return (
    <div className={styles.statsView}>
      <MetricStrip
        metrics={[
          {
            label: 'Attempted instances',
            value: stats.meta.totalInstances,
            icon: <ListChecks size={18} />,
          },
          {
            label: 'Completed',
            value: completion.completed,
            icon: <CheckCircle2 size={18} />,
          },
          {
            label: 'Completion rate',
            value: formatPercent(completion.completionRate),
            icon: <Activity size={18} />,
          },
          {
            label: 'Focus ratio',
            value: formatPercent(stats.focus.focusRatio),
            icon: <Clock3 size={18} />,
          },
        ]}
      />

      <p className={styles.metricCaveat}>
        These statistics cover materialized task instances only (
        {stats.meta.basis.replace(/-/g, ' ')}) from {stats.meta.from} through {stats.meta.to}. They
        measure recorded engagement, not every virtual schedule occurrence or schedule adherence.
      </p>

      <ReportSection title="Completion status">
        <div className={styles.statusGrid}>
          <StatusMetric label="Completed" value={completion.completed} />
          <StatusMetric label="Skipped" value={completion.skipped} />
          <StatusMetric label="Cancelled" value={completion.cancelled} />
          <StatusMetric label="Overdue" value={completion.overdue} />
          <StatusMetric label="In progress" value={completion.inProgress} />
          <StatusMetric label="To do" value={completion.toDo} />
        </div>
      </ReportSection>

      <ReportSection title="Weekly completion trend">
        {stats.trend.length === 0 ? (
          <SectionEmpty text="No weekly completion data is available for this range." />
        ) : (
          <StatsTable headings={['Week beginning', 'Completed', 'Attempted', 'Completion rate']}>
            {stats.trend.map((row) => (
              <tr key={row.weekStart}>
                <td>{row.weekStart}</td>
                <td>{row.completed}</td>
                <td>{row.total}</td>
                <td>{formatPercent(row.completionRate)}</td>
              </tr>
            ))}
          </StatsTable>
        )}
      </ReportSection>

      <div className={styles.twoColumnSections}>
        <ReportSection title="By task">
          {stats.byTask.length === 0 ? (
            <SectionEmpty text="No task breakdown is available." />
          ) : (
            <StatsTable headings={['Task', 'Completed', 'Attempted', 'Rate']}>
              {stats.byTask.map((row) => (
                <tr key={row.taskId}>
                  <td>
                    <span className={styles.cellTitle}>{row.title}</span>
                    <IdCell id={row.taskId} />
                  </td>
                  <td>{row.completed}</td>
                  <td>{row.total}</td>
                  <td>{formatPercent(row.completionRate)}</td>
                </tr>
              ))}
            </StatsTable>
          )}
        </ReportSection>

        <ReportSection title="By category">
          {stats.byCategory.length === 0 ? (
            <SectionEmpty text="No category breakdown is available." />
          ) : (
            <StatsTable headings={['Category', 'Completed', 'Attempted', 'Rate']}>
              {stats.byCategory.map((row, index) => (
                <tr key={`${row.categoryId}-${index}`}>
                  <td>
                    <span className={styles.cellTitle}>{row.categoryName}</span>
                    <span className={styles.secondaryValue}>{row.categoryId}</span>
                  </td>
                  <td>{row.completed}</td>
                  <td>{row.total}</td>
                  <td>{formatPercent(row.completionRate)}</td>
                </tr>
              ))}
            </StatsTable>
          )}
        </ReportSection>
      </div>

      <ReportSection title="Step active time">
        <p className={styles.sectionHelp}>
          Average server-recorded active time for steps that were started; paused and idle gaps are
          excluded.
        </p>
        {stats.stepDwell.length === 0 ? (
          <SectionEmpty text="No started-step timing samples are available." />
        ) : (
          <StatsTable headings={['Task and step', 'Step', 'Samples', 'Average active time']}>
            {stats.stepDwell.map((row) => (
              <tr key={`${row.taskId}-${row.stepOrder}`}>
                <td>
                  <span className={styles.cellTitle}>{row.title}</span>
                  <span className={styles.secondaryValue}>{row.stepText}</span>
                </td>
                <td>{row.stepOrder}</td>
                <td>{row.samples}</td>
                <td>{formatDuration(row.avgSeconds)}</td>
              </tr>
            ))}
          </StatsTable>
        )}
      </ReportSection>

      <ReportSection title="Focus by task">
        <p className={styles.sectionHelp}>
          Focus ratio is active time divided by elapsed wall-clock time for qualifying completed
          instances. Current value: {formatPercent(stats.focus.focusRatio)}.
        </p>
        {stats.focus.byTask.length === 0 ? (
          <SectionEmpty text="No instance timing samples are available." />
        ) : (
          <StatsTable headings={['Task', 'Samples', 'Average active time']}>
            {stats.focus.byTask.map((row) => (
              <tr key={row.taskId}>
                <td>
                  <span className={styles.cellTitle}>{row.title}</span>
                  <IdCell id={row.taskId} />
                </td>
                <td>{row.samples}</td>
                <td>{formatDuration(row.avgActiveSeconds)}</td>
              </tr>
            ))}
          </StatsTable>
        )}
      </ReportSection>

      <div className={styles.twoColumnSections}>
        <ReportSection title="Skipped tasks">
          {stats.skipPatterns.byTask.length === 0 ? (
            <SectionEmpty text="No skipped tasks were recorded." />
          ) : (
            <StatsTable headings={['Task', 'Skipped']}>
              {stats.skipPatterns.byTask.map((row) => (
                <tr key={row.taskId}>
                  <td>
                    <span className={styles.cellTitle}>{row.title}</span>
                    <IdCell id={row.taskId} />
                  </td>
                  <td>{row.skipped}</td>
                </tr>
              ))}
            </StatsTable>
          )}
        </ReportSection>

        <HourlySection
          title="Skip time of day"
          values={stats.skipPatterns.byHour}
          emptyText="No hourly skip pattern is available."
        />
      </div>

      <ReportSection title="Abandoned task instances">
        <p className={styles.sectionHelp}>
          Started instances that were neither completed nor cancelled, with the first incomplete
          step when one could be determined.
        </p>
        {stats.abandonment.length === 0 ? (
          <SectionEmpty text="No abandoned instances were identified." />
        ) : (
          <StatsTable headings={['Task', 'Stalled at', 'Task instance']}>
            {stats.abandonment.map((row) => (
              <tr key={row.instanceId}>
                <td>
                  <span className={styles.cellTitle}>{row.title}</span>
                  <IdCell id={row.taskId} />
                </td>
                <td>
                  {row.stalledAtStepOrder == null
                    ? 'No incomplete step identified'
                    : `Step ${row.stalledAtStepOrder}`}
                </td>
                <td>
                  <Link
                    className={styles.instanceLink}
                    to={`/support/users/${encodeURIComponent(
                      userId,
                    )}/task-instances/${encodeURIComponent(row.instanceId)}`}
                  >
                    View completion details
                  </Link>
                  <IdCell id={row.instanceId} />
                </td>
              </tr>
            ))}
          </StatsTable>
        )}
      </ReportSection>

      <HourlySection
        title="Completion time of day"
        values={stats.timeOfDay}
        emptyText="No completion-hour pattern is available."
      />

      <details className={styles.rawStats}>
        <summary>Raw deterministic statistics</summary>
        <pre>{JSON.stringify(stats, null, 2)}</pre>
      </details>
    </div>
  );
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.reportSection}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function HourlySection({
  title,
  values,
  emptyText,
}: {
  title: string;
  values: number[];
  emptyText: string;
}) {
  const nonZeroHours = values
    .map((count, hour) => ({ hour, count }))
    .filter(({ count }) => count > 0);

  return (
    <ReportSection title={title}>
      {nonZeroHours.length === 0 ? (
        <SectionEmpty text={emptyText} />
      ) : (
        <StatsTable headings={['Hour', 'Instances']}>
          {nonZeroHours.map(({ hour, count }) => (
            <tr key={hour}>
              <td>{formatHour(hour)}</td>
              <td>{count}</td>
            </tr>
          ))}
        </StatsTable>
      )}
    </ReportSection>
  );
}

function StatusMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.statusMetric}>
      <span className={styles.statusValue}>{value}</span>
      <span className={styles.statusLabel}>{label}</span>
    </div>
  );
}

function StatsTable({ headings, children }: { headings: string[]; children: ReactNode }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.statsTable}>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function SectionEmpty({ text }: { text: string }) {
  return (
    <div className={styles.compactEmpty}>
      <EmptyState title={text} />
    </div>
  );
}
