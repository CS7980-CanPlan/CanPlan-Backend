// Schedule validation + occurrence expansion for TaskAssignments.
//
// A TaskAssignment is either ONE_TIME (a single `scheduledFor` instant) or RECURRING (an
// RRULE `scheduleRule` anchored at `startDate` + `startTime`, in an IANA `timezone`). We use
// a real recurrence library (rrule) for the recurrence math and luxon for timezone-correct
// instant/date handling — no hand-rolled RRULE parsing.
//
// rrule operates on timezone-naive Date objects, so we feed it wall-clock components placed
// in UTC ("floating" dates) and interpret the resulting occurrences back in the assignment's
// timezone with luxon. That keeps a "09:00 daily in America/Toronto" rule firing at 09:00
// local across DST boundaries.

import { DateTime } from 'luxon';
import { RRule } from 'rrule';
import { ValidationError } from './response';
import type { TaskAssignment, TaskAssignmentScheduleType } from './types';

/** Hard cap on how wide a getTaskInstanceViews date range may be (keeps expansion bounded). */
export const MAX_RANGE_DAYS = 370;

/** One expanded occurrence of an assignment (a calendar slot, no status). */
export interface Occurrence {
  scheduledDate: string; // YYYY-MM-DD (in the assignment timezone)
  scheduledTime: string; // HH:mm (wall-clock in the assignment timezone)
  scheduledFor: string; // absolute ISO instant
  timezone: string;
}

/** Normalized, validated schedule fields ready to persist on a TaskAssignment. */
export interface NormalizedSchedule {
  scheduleType: TaskAssignmentScheduleType;
  timezone: string;
  scheduledFor?: string;
  scheduleRule?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** True when `time` is a valid `HH:mm` wall-clock string in 00:00–23:59. */
function isValidTime(time: string): boolean {
  if (!TIME_RE.test(time)) return false;
  const [hh, mm] = time.split(':').map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

/** True when `tz` is a resolvable IANA timezone. */
function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

/** Validate a `YYYY-MM-DD` calendar date (format + real date). */
function isValidDate(date: string): boolean {
  return DATE_RE.test(date) && DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: 'utc' }).isValid;
}

/** Build a timezone-naive ("floating") Date from wall-clock components, placed in UTC. */
function floatingUtc(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
}

/**
 * Validate the schedule portion of a createTaskAssignment input and return its normalized,
 * storable form. ONE_TIME requires `scheduledFor` + `timezone`; RECURRING requires
 * `scheduleRule` (a parseable RRULE) + `startDate` + `startTime` + `timezone`.
 */
export function normalizeSchedule(input: {
  scheduleType: TaskAssignmentScheduleType;
  scheduledFor?: string;
  scheduleRule?: string;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  timezone?: string;
}): NormalizedSchedule {
  const scheduleType = input.scheduleType;
  if (scheduleType !== 'ONE_TIME' && scheduleType !== 'RECURRING') {
    throw new ValidationError('scheduleType must be ONE_TIME or RECURRING');
  }
  const timezone = input.timezone?.trim();
  if (!timezone) throw new ValidationError('timezone is required and cannot be empty');
  if (!isValidTimezone(timezone)) throw new ValidationError(`invalid timezone "${timezone}"`);

  if (scheduleType === 'ONE_TIME') {
    const scheduledForRaw = input.scheduledFor?.trim();
    if (!scheduledForRaw) {
      throw new ValidationError('scheduledFor is required for a ONE_TIME assignment');
    }
    const dt = DateTime.fromISO(scheduledForRaw, { zone: timezone });
    if (!dt.isValid) throw new ValidationError(`scheduledFor is not a valid datetime`);
    return { scheduleType, timezone, scheduledFor: dt.toISO()! };
  }

  // RECURRING
  const scheduleRule = input.scheduleRule?.trim();
  const startDate = input.startDate?.trim();
  const startTime = input.startTime?.trim();
  const endDate = input.endDate?.trim();
  if (!scheduleRule) throw new ValidationError('scheduleRule is required for a RECURRING assignment');
  if (!startDate) throw new ValidationError('startDate is required for a RECURRING assignment');
  if (!startTime) throw new ValidationError('startTime is required for a RECURRING assignment');
  if (!isValidDate(startDate)) throw new ValidationError('startDate must be a valid YYYY-MM-DD date');
  if (!isValidTime(startTime)) throw new ValidationError('startTime must be a valid HH:mm time (00:00–23:59)');
  if (endDate != null && endDate !== '') {
    if (!isValidDate(endDate)) throw new ValidationError('endDate must be a valid YYYY-MM-DD date');
    if (endDate < startDate) throw new ValidationError('endDate cannot be before startDate');
  }
  // Validate the RRULE parses (rrule throws on malformed input).
  try {
    RRule.parseString(stripRrulePrefix(scheduleRule));
  } catch {
    throw new ValidationError(`scheduleRule is not a valid RRULE: "${scheduleRule}"`);
  }
  return {
    scheduleType,
    timezone,
    scheduleRule,
    startDate,
    startTime,
    endDate: endDate || undefined,
  };
}

/** Drop a leading `RRULE:` so both `RRULE:FREQ=…` and `FREQ=…` parse. */
function stripRrulePrefix(rule: string): string {
  return rule.replace(/^RRULE:/i, '');
}

/**
 * Validate that a requested view window is well-formed and within MAX_RANGE_DAYS. Returns the
 * inclusive [startDate, endDate] (both YYYY-MM-DD). Throws ValidationError otherwise.
 */
export function validateDateRange(startDate: string, endDate: string): { start: string; end: string } {
  const start = startDate?.trim();
  const end = endDate?.trim();
  if (!start || !isValidDate(start)) throw new ValidationError('startDate must be a valid YYYY-MM-DD date');
  if (!end || !isValidDate(end)) throw new ValidationError('endDate must be a valid YYYY-MM-DD date');
  if (end < start) throw new ValidationError('endDate cannot be before startDate');
  const startDt = DateTime.fromFormat(start, 'yyyy-MM-dd', { zone: 'utc' });
  const endDt = DateTime.fromFormat(end, 'yyyy-MM-dd', { zone: 'utc' });
  const days = endDt.diff(startDt, 'days').days + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ValidationError(`date range may span at most ${MAX_RANGE_DAYS} days`);
  }
  return { start, end };
}

/**
 * Expand an ACTIVE assignment's occurrences that fall within the inclusive [rangeStart,
 * rangeEnd] date window. Inactive assignments and out-of-window occurrences yield nothing.
 * The assignment's own startDate/endDate further clamp a RECURRING expansion.
 */
export function expandOccurrences(
  assignment: TaskAssignment,
  rangeStart: string,
  rangeEnd: string,
): Occurrence[] {
  if (!assignment.active) return [];

  if (assignment.scheduleType === 'ONE_TIME') {
    const occ = oneTimeOccurrence(assignment);
    if (!occ) return [];
    return occ.scheduledDate >= rangeStart && occ.scheduledDate <= rangeEnd ? [occ] : [];
  }

  // RECURRING
  const { scheduleRule, startDate, startTime, endDate, timezone } = assignment;
  if (!scheduleRule || !startDate || !startTime) return [];

  const effStart = rangeStart > startDate ? rangeStart : startDate;
  const cap = endDate && endDate < rangeEnd ? endDate : rangeEnd;
  if (effStart > cap) return [];

  let options: Partial<ReturnType<typeof RRule.parseString>>;
  try {
    options = RRule.parseString(stripRrulePrefix(scheduleRule));
  } catch {
    return [];
  }
  options.dtstart = floatingUtc(startDate, startTime);
  const rule = new RRule(options);

  // rrule works on naive UTC wall-clock; bound the window by the same convention.
  const after = floatingUtc(effStart, '00:00');
  const before = floatingUtc(cap, '23:59');
  const dates = rule.between(after, before, true);

  return dates.map((d) => buildOccurrence(d, timezone));
}

/** Resolve the single occurrence of a ONE_TIME assignment (null if its fields are absent). */
function oneTimeOccurrence(assignment: TaskAssignment): Occurrence | null {
  if (!assignment.scheduledFor) return null;
  const dt = DateTime.fromISO(assignment.scheduledFor, { zone: assignment.timezone });
  if (!dt.isValid) return null;
  return {
    scheduledDate: dt.toFormat('yyyy-MM-dd'),
    scheduledTime: dt.toFormat('HH:mm'),
    scheduledFor: dt.toISO()!,
    timezone: assignment.timezone,
  };
}

/** Turn a naive UTC wall-clock occurrence Date into a timezone-anchored Occurrence. */
function buildOccurrence(naiveUtc: Date, timezone: string): Occurrence {
  const year = naiveUtc.getUTCFullYear();
  const month = naiveUtc.getUTCMonth() + 1;
  const day = naiveUtc.getUTCDate();
  const hour = naiveUtc.getUTCHours();
  const minute = naiveUtc.getUTCMinutes();
  const scheduledDate = `${year}-${pad(month)}-${pad(day)}`;
  const scheduledTime = `${pad(hour)}:${pad(minute)}`;
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone: timezone });
  return { scheduledDate, scheduledTime, scheduledFor: dt.toISO()!, timezone };
}

/**
 * Whether (scheduledDate, scheduledTime) is a real occurrence of the assignment — used to
 * validate startTaskInstance / cancelTaskInstance against virtual schedule math.
 */
export function occurrenceFor(
  assignment: TaskAssignment,
  scheduledDate: string,
  scheduledTime: string,
): Occurrence | null {
  const occ = expandOccurrences(assignment, scheduledDate, scheduledDate).find(
    (o) => o.scheduledTime === scheduledTime,
  );
  return occ ?? null;
}
