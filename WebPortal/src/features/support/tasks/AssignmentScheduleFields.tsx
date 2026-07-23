import type { CreateTaskAssignmentInput, TaskAssignment } from '../../../api/apiTypes';
import { Select, type SelectOption } from '../../../components/ui/Select';
import { TextField } from '../../../components/ui/TextField';
import adminStyles from '../../admin/admin.module.css';
import {
  browserTimezone,
  buildRrule,
  parseRrule,
  todayIsoDate,
  type RecurrenceFrequency,
} from './taskSchedule';
import styles from './tasks.module.css';

export type ScheduleTypeChoice = 'ONE_TIME' | 'RECURRING';

export interface AssignmentScheduleDraft {
  scheduleType: ScheduleTypeChoice;
  timezone: string;
  oneTimeAt: string;
  frequency: RecurrenceFrequency;
  interval: string;
  startDate: string;
  startTime: string;
  endDate: string;
}

export type AssignmentScheduleErrors = Record<string, string>;

const FREQUENCY_OPTIONS: SelectOption[] = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
];

export function createDefaultScheduleDraft(): AssignmentScheduleDraft {
  return {
    scheduleType: 'ONE_TIME',
    timezone: browserTimezone(),
    oneTimeAt: '',
    frequency: 'DAILY',
    interval: '',
    startDate: todayIsoDate(),
    startTime: '09:00',
    endDate: '',
  };
}

/**
 * Prefill a replacement form. Recurring replacements deliberately start on `effectiveDate`
 * instead of cloning the historical start date, otherwise the new rule would duplicate past
 * virtual occurrences.
 */
export function scheduleDraftFromAssignment(
  assignment: TaskAssignment,
  effectiveDate: string,
): AssignmentScheduleDraft {
  const parsed = assignment.scheduleRule ? parseRrule(assignment.scheduleRule) : {};
  const endDate =
    assignment.endDate && assignment.endDate >= effectiveDate ? assignment.endDate : '';

  return {
    scheduleType: assignment.scheduleType,
    timezone: assignment.timezone,
    oneTimeAt: assignment.scheduledFor
      ? instantToDateTimeLocal(assignment.scheduledFor, assignment.timezone)
      : '',
    frequency: parsed.frequency ?? 'DAILY',
    interval: parsed.interval && parsed.interval > 1 ? String(parsed.interval) : '',
    startDate: effectiveDate,
    startTime: assignment.startTime ?? '09:00',
    endDate,
  };
}

export function validateAssignmentSchedule(
  draft: AssignmentScheduleDraft,
): AssignmentScheduleErrors {
  const errors: AssignmentScheduleErrors = {};
  if (!draft.timezone.trim()) errors.timezone = 'A timezone is required.';

  if (draft.scheduleType === 'ONE_TIME') {
    if (!draft.oneTimeAt) errors.oneTimeAt = 'Pick the date and time.';
    return errors;
  }

  if (!draft.startDate) errors.startDate = 'A start date is required.';
  if (!draft.startTime) errors.startTime = 'A start time is required.';
  if (draft.interval !== '') {
    const parsed = Number(draft.interval);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.interval = 'Interval must be a positive whole number.';
    }
  }
  if (draft.endDate && draft.startDate && draft.endDate < draft.startDate) {
    errors.endDate = 'End date cannot be before the start date.';
  }
  return errors;
}

export function assignmentInputFromDraft(
  taskId: string,
  userId: string,
  draft: AssignmentScheduleDraft,
): CreateTaskAssignmentInput {
  const timezone = draft.timezone.trim();
  return draft.scheduleType === 'ONE_TIME'
    ? {
        taskId,
        userId,
        scheduleType: 'ONE_TIME',
        scheduledFor: draft.oneTimeAt,
        timezone,
      }
    : {
        taskId,
        userId,
        scheduleType: 'RECURRING',
        scheduleRule: buildRrule(
          draft.frequency,
          draft.interval === '' ? undefined : Number(draft.interval),
        ),
        startDate: draft.startDate,
        startTime: draft.startTime,
        ...(draft.endDate ? { endDate: draft.endDate } : {}),
        timezone,
      };
}

/** The local calendar date where the replacement starts and the old rule is cut off. */
export function replacementEffectiveDate(draft: AssignmentScheduleDraft): string {
  return draft.scheduleType === 'ONE_TIME' ? draft.oneTimeAt.slice(0, 10) : draft.startDate;
}

export function AssignmentScheduleFields({
  idPrefix,
  draft,
  errors,
  disabled = false,
  recurringStartLabel = 'Start date',
  recurringStartHint,
  minimumDate,
  onChange,
}: {
  idPrefix: string;
  draft: AssignmentScheduleDraft;
  errors: AssignmentScheduleErrors;
  disabled?: boolean;
  recurringStartLabel?: string;
  recurringStartHint?: string;
  minimumDate?: string;
  onChange: (next: AssignmentScheduleDraft) => void;
}) {
  const patchDraft = (patch: Partial<AssignmentScheduleDraft>) => onChange({ ...draft, ...patch });

  return (
    <>
      <TextField
        label="Timezone"
        required
        value={draft.timezone}
        error={errors.timezone}
        disabled={disabled}
        hint='IANA name, e.g. "America/Toronto". The schedule is interpreted in it.'
        onChange={(event) => patchDraft({ timezone: event.target.value })}
      />

      <fieldset className={styles.scheduleFieldset} disabled={disabled}>
        <legend className={styles.scheduleLegend}>Schedule type</legend>
        <div className={styles.radioRow}>
          <label className={styles.radioOption}>
            <input
              type="radio"
              name={`${idPrefix}-schedule-type`}
              value="ONE_TIME"
              checked={draft.scheduleType === 'ONE_TIME'}
              onChange={() => patchDraft({ scheduleType: 'ONE_TIME' })}
            />
            One-time
          </label>
          <label className={styles.radioOption}>
            <input
              type="radio"
              name={`${idPrefix}-schedule-type`}
              value="RECURRING"
              checked={draft.scheduleType === 'RECURRING'}
              onChange={() => patchDraft({ scheduleType: 'RECURRING' })}
            />
            Recurring
          </label>
        </div>
      </fieldset>

      {draft.scheduleType === 'ONE_TIME' ? (
        <TextField
          label="Date and time"
          required
          type="datetime-local"
          min={minimumDate ? `${minimumDate}T00:00` : undefined}
          value={draft.oneTimeAt}
          error={errors.oneTimeAt}
          disabled={disabled}
          hint="Local wall-clock time in the timezone above."
          onChange={(event) => patchDraft({ oneTimeAt: event.target.value })}
        />
      ) : (
        <>
          <div className={adminStyles.formRow}>
            <Select
              label="Frequency"
              required
              options={FREQUENCY_OPTIONS}
              value={draft.frequency}
              disabled={disabled}
              onChange={(event) =>
                patchDraft({ frequency: event.target.value as RecurrenceFrequency })
              }
            />
            <TextField
              label="Repeat every (optional)"
              type="number"
              min={1}
              step={1}
              value={draft.interval}
              error={errors.interval}
              disabled={disabled}
              hint="e.g. 2 with Weekly = every 2 weeks. Leave blank for every occurrence."
              onChange={(event) => patchDraft({ interval: event.target.value })}
            />
          </div>
          <div className={adminStyles.formRow}>
            <TextField
              label={recurringStartLabel}
              required
              type="date"
              min={minimumDate}
              value={draft.startDate}
              error={errors.startDate}
              disabled={disabled}
              hint={recurringStartHint}
              onChange={(event) => patchDraft({ startDate: event.target.value })}
            />
            <TextField
              label="Start time"
              required
              type="time"
              value={draft.startTime}
              error={errors.startTime}
              disabled={disabled}
              onChange={(event) => patchDraft({ startTime: event.target.value })}
            />
          </div>
          <TextField
            label="End date (optional)"
            type="date"
            min={draft.startDate || undefined}
            value={draft.endDate}
            error={errors.endDate}
            disabled={disabled}
            hint="Leave blank for an open-ended schedule."
            onChange={(event) => patchDraft({ endDate: event.target.value })}
          />
        </>
      )}
    </>
  );
}

/** Convert an ISO instant into the assignment timezone without browser-zone drift. */
function instantToDateTimeLocal(instant: string, timezone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant.slice(0, 16);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = valueOf('year');
    const month = valueOf('month');
    const day = valueOf('day');
    const hour = valueOf('hour');
    const minute = valueOf('minute');
    if (year && month && day && hour && minute) {
      return `${year}-${month}-${day}T${hour}:${minute}`;
    }
  } catch {
    // Invalid legacy timezone: retain the stored ISO wall-clock prefix as a best effort.
  }
  return instant.slice(0, 16);
}
