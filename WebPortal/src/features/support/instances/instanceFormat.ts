import type { TaskInstanceStatus } from '../../../api/apiTypes';

export const INSTANCE_STATUS_OPTIONS: { value: 'ALL' | TaskInstanceStatus; label: string }[] = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'TO_DO', label: 'To do' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'SKIPPED', label: 'Skipped' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** Format an integer duration without hiding long-running tasks behind a clock time. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

/** Local calendar date, intentionally avoiding UTC conversion around midnight. */
function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultInstanceHistoryRange(): { startDate: string; endDate: string } {
  const today = toLocalIsoDate(new Date());
  return { startDate: today, endDate: today };
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Match the backend's inclusive maximum of 370 days before issuing a query. */
export function validateInstanceHistoryRange(startDate: string, endDate: string): string | null {
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) {
    return 'Choose a valid start and end date.';
  }
  if (endDate < startDate) return 'The end date cannot be before the start date.';
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  const inclusiveDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  return inclusiveDays > 370 ? 'The date range can span at most 370 days.' : null;
}

export function scheduledDateTimeLabel(
  scheduledFor: string,
  timezone: string,
  fallbackDate: string,
  fallbackTime: string,
): string {
  const date = new Date(scheduledFor);
  if (Number.isNaN(date.getTime())) return `${fallbackDate} at ${fallbackTime} (${timezone})`;
  try {
    return `${date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
      timeZoneName: 'short',
    })}`;
  } catch {
    return `${fallbackDate} at ${fallbackTime} (${timezone})`;
  }
}
