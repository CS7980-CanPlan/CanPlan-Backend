import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, ListPlus, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { TaskInstanceStatus, TaskInstanceView } from '../../../api/apiTypes';
import { useUserCalendar } from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { Panel } from '../../admin/components/Panel';
import { IdCell, StatusBadge } from '../../admin/components/display';
import styles from './calendar.module.css';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CALENDAR_CELL_COUNT = 42;
const MAX_CELL_EVENTS = 3;

interface CalendarDay {
  date: Date;
  isoDate: string;
  belongsToMonth: boolean;
}

const STATUS_CLASS: Record<TaskInstanceStatus, string> = {
  TO_DO: styles.statusTodo,
  IN_PROGRESS: styles.statusInProgress,
  OVERDUE: styles.statusOverdue,
  COMPLETED: styles.statusCompleted,
  SKIPPED: styles.statusSkipped,
  CANCELLED: styles.statusCancelled,
};

export interface SupportedUserCalendarProps {
  userId: string;
  displayName: string;
}

/**
 * Read-only month calendar for a delegated primary user. It deliberately uses
 * getTaskInstanceViews rather than the self-scoped TaskInstance reads: the response overlays
 * real TaskInstances onto virtual occurrences generated from active schedule rules.
 */
export function SupportedUserCalendar({ userId, displayName }: SupportedUserCalendarProps) {
  const navigate = useNavigate();
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()));

  const days = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const startDate = days[0]?.isoDate ?? toIsoDate(visibleMonth);
  const endDate = days[days.length - 1]?.isoDate ?? startDate;
  const calendarQuery = useUserCalendar(userId, startDate, endDate);

  const occurrences = useMemo(
    () => [...(calendarQuery.data?.items ?? [])].sort(compareOccurrences),
    [calendarQuery.data],
  );
  const visibleMonthOccurrences = useMemo(
    () => occurrences.filter((occurrence) => isIsoDateInMonth(occurrence.scheduledDate, visibleMonth)),
    [occurrences, visibleMonth],
  );
  const occurrencesByDate = useMemo(() => groupOccurrencesByDate(occurrences), [occurrences]);
  const selectedOccurrences = occurrencesByDate.get(selectedDate) ?? [];
  const today = toIsoDate(new Date());

  function showMonth(offset: number) {
    const nextMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1, 12);
    setVisibleMonth(nextMonth);
    setSelectedDate(
      isSameMonth(nextMonth, new Date()) ? today : toIsoDate(startOfMonth(nextMonth)),
    );
  }

  function showToday() {
    const now = new Date();
    setVisibleMonth(startOfMonth(now));
    setSelectedDate(toIsoDate(now));
  }

  return (
    <div id="calendar" className={styles.anchor}>
      <Panel
        title="Calendar"
        description={`Scheduled tasks and task instances for ${displayName}.`}
        icon={<CalendarDays size={16} />}
      >
        <div className={styles.toolbar}>
          <div className={styles.monthNavigation}>
            <Button
              size="sm"
              variant="secondary"
              icon={<ChevronLeft size={15} />}
              aria-label="Previous month"
              onClick={() => showMonth(-1)}
            >
              Previous
            </Button>
            <Button size="sm" variant="ghost" onClick={showToday}>
              Today
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<ChevronRight size={15} />}
              aria-label="Next month"
              onClick={() => showMonth(1)}
            >
              Next
            </Button>
          </div>

          <h3 className={styles.monthLabel} aria-live="polite">
            {formatMonth(visibleMonth)}
          </h3>

          <div className={styles.actions}>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} />}
              onClick={() => calendarQuery.refetch()}
              disabled={calendarQuery.isFetching}
            >
              {calendarQuery.isFetching && !calendarQuery.isLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button
              size="sm"
              icon={<ListPlus size={14} />}
              onClick={() => navigate(`/support/tasks?assignTo=${encodeURIComponent(userId)}`)}
            >
              Assign a task
            </Button>
          </div>
        </div>

        <div className={styles.legend} aria-label="Calendar legend">
          <span>
            <span className={`${styles.legendMarker} ${styles.virtualMarker}`} />
            Scheduled
          </span>
          <span>
            <span className={`${styles.legendMarker} ${styles.instanceMarker}`} />
            Task instance
          </span>
          <span className={styles.legendHelp}>
            Scheduled items are virtual until someone starts or changes that occurrence.
          </span>
        </div>

        {calendarQuery.isLoading ? (
          <div className={styles.centered}>
            <Spinner label="Loading calendar…" />
          </div>
        ) : calendarQuery.isError ? (
          <div className={styles.errorBlock}>
            <Alert variant="error" title="Could not load this calendar">
              {gqlErrorMessage(calendarQuery.error)} You can only view this schedule while you
              actively support this user.
            </Alert>
            <Button size="sm" variant="secondary" onClick={() => calendarQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.desktopCalendar}>
              <div className={styles.weekdayRow} aria-hidden="true">
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div className={styles.calendarGrid}>
                {days.map((day) => (
                  <CalendarCell
                    key={day.isoDate}
                    day={day}
                    occurrences={occurrencesByDate.get(day.isoDate) ?? []}
                    selected={day.isoDate === selectedDate}
                    today={day.isoDate === today}
                    onSelect={() => setSelectedDate(day.isoDate)}
                  />
                ))}
              </div>
            </div>

            <MobileAgenda
              occurrences={visibleMonthOccurrences}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />

            {visibleMonthOccurrences.length === 0 && (
              <div className={styles.emptyBlock}>
                <EmptyState
                  icon={<CalendarDays size={32} />}
                  title="No scheduled tasks this month"
                  description="Assign one of your task templates to add a one-time or recurring schedule."
                />
              </div>
            )}

            {(visibleMonthOccurrences.length > 0 || selectedOccurrences.length > 0) && (
              <SelectedDayDetails date={selectedDate} occurrences={selectedOccurrences} />
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

function CalendarCell({
  day,
  occurrences,
  selected,
  today,
  onSelect,
}: {
  day: CalendarDay;
  occurrences: TaskInstanceView[];
  selected: boolean;
  today: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        styles.dayCell,
        day.belongsToMonth ? '' : styles.outsideMonth,
        selected ? styles.selectedDay : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`${formatLongDate(day.isoDate)}, ${occurrences.length} scheduled task${occurrences.length === 1 ? '' : 's'}`}
      aria-pressed={selected}
      aria-current={today ? 'date' : undefined}
      onClick={onSelect}
    >
      <span className={`${styles.dayNumber} ${today ? styles.todayNumber : ''}`}>
        {day.date.getDate()}
      </span>
      <span className={styles.cellEvents}>
        {occurrences.slice(0, MAX_CELL_EVENTS).map((occurrence) => (
          <span
            key={occurrenceKey(occurrence)}
            className={`${styles.cellEvent} ${STATUS_CLASS[occurrence.status]} ${occurrence.isVirtual ? styles.virtualEvent : styles.instanceEvent}`}
            title={`${formatWallClockTime(occurrence.scheduledTime)} · ${taskTitle(occurrence)} · ${occurrence.status.replace(/_/g, ' ')}`}
          >
            <span className={styles.cellEventTime}>
              {formatWallClockTime(occurrence.scheduledTime)}
            </span>
            <span className={styles.cellEventTitle}>{taskTitle(occurrence)}</span>
          </span>
        ))}
        {occurrences.length > MAX_CELL_EVENTS && (
          <span className={styles.moreEvents}>+{occurrences.length - MAX_CELL_EVENTS} more</span>
        )}
      </span>
    </button>
  );
}

function MobileAgenda({
  occurrences,
  selectedDate,
  onSelectDate,
}: {
  occurrences: TaskInstanceView[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
}) {
  const groups = [...groupOccurrencesByDate(occurrences).entries()];
  if (groups.length === 0) return null;

  function selectAndReveal(date: string) {
    onSelectDate(date);
    window.requestAnimationFrame(() => {
      const heading = document.getElementById('selected-calendar-date');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: 'start' });
    });
  }

  return (
    <div className={styles.mobileAgenda}>
      {groups.map(([date, items]) => (
        <section key={date} className={styles.agendaDay}>
          <button
            type="button"
            className={`${styles.agendaDate} ${date === selectedDate ? styles.agendaDateSelected : ''}`}
            aria-pressed={date === selectedDate}
            onClick={() => selectAndReveal(date)}
          >
            {formatLongDate(date)}
          </button>
          <div className={styles.agendaItems}>
            {items.map((occurrence) => (
              <button
                type="button"
                key={occurrenceKey(occurrence)}
                className={`${styles.agendaItem} ${occurrence.isVirtual ? styles.virtualEvent : styles.instanceEvent}`}
                aria-label={`${formatWallClockTime(occurrence.scheduledTime)}, ${taskTitle(occurrence)}, ${occurrence.status.replace(/_/g, ' ')}, ${occurrence.isVirtual ? 'scheduled occurrence' : 'task instance'}`}
                onClick={() => selectAndReveal(date)}
              >
                <span className={styles.agendaTime}>
                  {formatWallClockTime(occurrence.scheduledTime)}
                </span>
                <span className={styles.agendaTitle}>{taskTitle(occurrence)}</span>
                <StatusBadge status={occurrence.status} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SelectedDayDetails({
  date,
  occurrences,
}: {
  date: string;
  occurrences: TaskInstanceView[];
}) {
  return (
    <section
      className={styles.dayDetails}
      aria-labelledby="selected-calendar-date"
      aria-live="polite"
    >
      <div className={styles.dayDetailsHead}>
        <h3 id="selected-calendar-date" tabIndex={-1}>{formatLongDate(date)}</h3>
        <span>
          {occurrences.length} task{occurrences.length === 1 ? '' : 's'}
        </span>
      </div>
      {occurrences.length === 0 ? (
        <p className={styles.noDayEvents}>Nothing is scheduled for this day.</p>
      ) : (
        <div className={styles.detailList}>
          {occurrences.map((occurrence) => (
            <article
              key={occurrenceKey(occurrence)}
              className={`${styles.occurrenceCard} ${occurrence.isVirtual ? styles.virtualOccurrence : styles.realOccurrence}`}
            >
              <div className={styles.occurrenceHead}>
                <div>
                  <div className={styles.occurrenceTime}>
                    {formatWallClockTime(occurrence.scheduledTime)}
                  </div>
                  <h4 className={styles.occurrenceTitle}>{taskTitle(occurrence)}</h4>
                </div>
                <div className={styles.occurrenceBadges}>
                  <StatusBadge status={occurrence.status} />
                  <Badge tone={occurrence.isVirtual ? 'neutral' : 'info'}>
                    {occurrence.isVirtual ? 'Scheduled' : 'Task instance'}
                  </Badge>
                  {occurrence.isException && <Badge tone="warning">Exception</Badge>}
                </div>
              </div>
              <p className={styles.timezone}>
                Scheduled at {occurrence.scheduledTime} in {occurrence.timezone}
              </p>
              <dl className={styles.occurrenceIds}>
                <div>
                  <dt>Task</dt>
                  <dd>
                    <IdCell id={occurrence.taskId} />
                  </dd>
                </div>
                <div>
                  <dt>Assignment</dt>
                  <dd>
                    <IdCell id={occurrence.assignmentId} />
                  </dd>
                </div>
                <div>
                  <dt>Instance</dt>
                  <dd>
                    {occurrence.instanceId ? (
                      <IdCell id={occurrence.instanceId} />
                    ) : (
                      <span className={styles.notCreated}>Not created yet</span>
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function isSameMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

function isIsoDateInMonth(isoDate: string, month: Date): boolean {
  const date = dateFromIso(isoDate);
  return isSameMonth(date, month);
}

/** Format a browser-local Date without converting it through UTC. */
function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromIso(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function buildCalendarDays(month: Date): CalendarDay[] {
  const firstOfMonth = startOfMonth(month);
  const gridStart = new Date(
    firstOfMonth.getFullYear(),
    firstOfMonth.getMonth(),
    1 - firstOfMonth.getDay(),
    12,
  );
  return Array.from({ length: CALENDAR_CELL_COUNT }, (_, index) => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + index,
      12,
    );
    return {
      date,
      isoDate: toIsoDate(date),
      belongsToMonth: isSameMonth(date, firstOfMonth),
    };
  });
}

function groupOccurrencesByDate(occurrences: TaskInstanceView[]): Map<string, TaskInstanceView[]> {
  const grouped = new Map<string, TaskInstanceView[]>();
  for (const occurrence of occurrences) {
    const current = grouped.get(occurrence.scheduledDate) ?? [];
    current.push(occurrence);
    grouped.set(occurrence.scheduledDate, current);
  }
  return grouped;
}

function compareOccurrences(left: TaskInstanceView, right: TaskInstanceView): number {
  return (
    left.scheduledDate.localeCompare(right.scheduledDate) ||
    left.scheduledTime.localeCompare(right.scheduledTime) ||
    taskTitle(left).localeCompare(taskTitle(right)) ||
    left.assignmentId.localeCompare(right.assignmentId)
  );
}

function occurrenceKey(occurrence: TaskInstanceView): string {
  return occurrence.instanceId
    ? `instance:${occurrence.instanceId}`
    : `virtual:${occurrence.assignmentId}:${occurrence.scheduledDate}:${occurrence.scheduledTime}`;
}

function taskTitle(occurrence: TaskInstanceView): string {
  return occurrence.title.trim() || 'Task unavailable';
}

function formatMonth(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatLongDate(isoDate: string): string {
  return dateFromIso(isoDate).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format the returned wall-clock time without applying the supporter's timezone. */
function formatWallClockTime(time: string): string {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return time;
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]), 0, 0);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
