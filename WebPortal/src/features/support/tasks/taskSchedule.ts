/**
 * Schedule helpers for the Tasks module: build the RRULE the backend expects and render a
 * stored TaskAssignment schedule as a human-readable sentence. The backend accepts only
 * FREQ=DAILY/WEEKLY/MONTHLY/YEARLY (+ optional INTERVAL), so that is all we ever generate.
 */
import type { TaskAssignment } from '../../../api/apiTypes';

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** The browser's IANA timezone — the default for new assignments. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Build a backend-valid RRULE, e.g. `FREQ=DAILY` or `FREQ=WEEKLY;INTERVAL=2`. */
export function buildRrule(frequency: RecurrenceFrequency, interval?: number): string {
  const base = `FREQ=${frequency}`;
  return interval && interval > 1 ? `${base};INTERVAL=${interval}` : base;
}

const FREQ_UNIT: Record<RecurrenceFrequency, [singular: string, plural: string]> = {
  DAILY: ['day', 'days'],
  WEEKLY: ['week', 'weeks'],
  MONTHLY: ['month', 'months'],
  YEARLY: ['year', 'years'],
};

/** Parse `FREQ` and `INTERVAL` back out of a stored RRULE (tolerates an `RRULE:` prefix). */
function parseRrule(rule: string): { frequency?: RecurrenceFrequency; interval?: number } {
  const parts = rule.replace(/^RRULE:/i, '').split(';');
  const result: { frequency?: RecurrenceFrequency; interval?: number } = {};
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key?.toUpperCase() === 'FREQ' && RECURRENCE_FREQUENCIES.includes(value as RecurrenceFrequency)) {
      result.frequency = value as RecurrenceFrequency;
    }
    if (key?.toUpperCase() === 'INTERVAL') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) result.interval = parsed;
    }
  }
  return result;
}

/** Format an ISO instant in the assignment's own timezone (falls back to raw text). */
function formatInstant(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    });
  } catch {
    // Unknown/invalid stored timezone — fall back to the viewer's locale zone.
    return date.toLocaleString();
  }
}

/** One human-readable sentence describing an assignment's schedule. */
export function describeSchedule(assignment: TaskAssignment): string {
  if (assignment.scheduleType === 'ONE_TIME') {
    const when = assignment.scheduledFor
      ? formatInstant(assignment.scheduledFor, assignment.timezone)
      : 'unknown time';
    return `Once on ${when} (${assignment.timezone})`;
  }

  const { frequency, interval } = assignment.scheduleRule
    ? parseRrule(assignment.scheduleRule)
    : {};
  const every = frequency
    ? interval && interval > 1
      ? `Every ${interval} ${FREQ_UNIT[frequency][1]}`
      : FREQ_UNIT[frequency][0] === 'day'
        ? 'Every day'
        : `Every ${FREQ_UNIT[frequency][0]}`
    : `Recurring (${assignment.scheduleRule ?? 'no rule'})`;
  const at = assignment.startTime ? ` at ${assignment.startTime}` : '';
  const from = assignment.startDate ? ` from ${assignment.startDate}` : '';
  const until = assignment.endDate ? ` until ${assignment.endDate}` : '';
  return `${every}${at}${from}${until} (${assignment.timezone})`;
}

/** Today's date in the browser's timezone as YYYY-MM-DD (for date-input defaults/minimums). */
export function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
