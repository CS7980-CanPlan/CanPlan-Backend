import type { Report, ReportDateRange, ReportDocument, ReportStats } from '../../../api/apiTypes';
import { parseReportDateRange, parseReportScope, parseReportStats } from '../../../api/supportApi';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Browser-local date, so "today" does not jump a day around a UTC boundary. */
export function todayIsoDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validate the report service's documented inclusive maximum of 366 calendar days. */
export function validateReportRange(from: string, to: string): string | null {
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return 'Choose valid From and To dates.';
  }
  if (to < from) return 'The To date cannot be before the From date.';

  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const inclusiveDays = Math.round((toMs - fromMs) / DAY_MS) + 1;
  return inclusiveDays > 366 ? 'A report can cover at most 366 calendar days.' : null;
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59`;
}

/** listReports carries AWSJSON strings and can contain old/malformed metadata. */
export function savedReportRange(report: Report): ReportDateRange | null {
  if (!report.dateRange) return null;
  try {
    return parseReportDateRange(report.dateRange);
  } catch {
    return null;
  }
}

/** Extract the subject id from list metadata, tolerating old/malformed AWSJSON rows. */
export function savedReportUserId(report: Report): string | null {
  if (!report.scope) return null;
  try {
    return parseReportScope(report.scope).userId;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Downloaded report is missing ${field}.`);
  }
  return value;
}

/**
 * Validate an S3 report before showing it. The GraphQL parsers are deliberately reused so
 * downloaded and generated reports follow the same presentation contract.
 */
export function parseReportDocument(value: unknown): ReportDocument {
  if (!isRecord(value)) throw new Error('Downloaded report is not a JSON object.');
  if (!isRecord(value.scope) || !isRecord(value.dateRange) || !isRecord(value.stats)) {
    throw new Error('Downloaded report is missing its scope, date range, or statistics.');
  }

  const scope = parseReportScope(JSON.stringify(value.scope));
  const dateRange = parseReportDateRange(JSON.stringify(value.dateRange));
  const stats = parseReportStats(JSON.stringify(value.stats));
  assertCompleteStats(stats);
  if (
    stats.meta.userId !== scope.userId ||
    stats.meta.from !== dateRange.from ||
    stats.meta.to !== dateRange.to
  ) {
    throw new Error('Downloaded report statistics do not match its scope or date range.');
  }

  return {
    reportId: requireString(value, 'reportId'),
    scope,
    dateRange,
    createdBy: requireString(value, 'createdBy'),
    createdAt: requireString(value, 'createdAt'),
    narrative: requireString(value, 'narrative'),
    stats,
  };
}

/** Guard every collection consumed by ReportStatsView so malformed AWSJSON cannot crash it. */
export function assertCompleteStats(stats: ReportStats): void {
  const arrays: Array<[string, unknown]> = [
    ['trend', stats.trend],
    ['byCategory', stats.byCategory],
    ['byTask', stats.byTask],
    ['stepDwell', stats.stepDwell],
    ['focus.byTask', stats.focus?.byTask],
    ['skipPatterns.byTask', stats.skipPatterns?.byTask],
    ['skipPatterns.byHour', stats.skipPatterns?.byHour],
    ['abandonment', stats.abandonment],
    ['timeOfDay', stats.timeOfDay],
  ];

  if (
    !stats.meta ||
    !stats.completion ||
    !stats.focus ||
    !stats.skipPatterns ||
    arrays.some(([, value]) => !Array.isArray(value))
  ) {
    throw new Error('Report statistics have an unsupported response format.');
  }
}
