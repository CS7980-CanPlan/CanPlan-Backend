import { randomUUID } from 'crypto';
import { requireCaller } from '../../shared/authz';
import { pageArgs } from '../../shared/pagination';
import { buildReportStats } from '../../shared/reportMetrics';
import { assertCanAccessUserReports } from '../../shared/reportAuthz';
import { generateReportNarrative } from '../../shared/reportNarrative';
import {
  deleteReport,
  getReportDownloadUrl,
  listReports,
  writeReport,
} from '../../shared/reportStorage';
import { ValidationError } from '../../shared/response';
import type {
  AppSyncEvent,
  Connection,
  GenerateReportInput,
  MediaDownloadTarget,
  Report,
  ReportDocument,
} from '../../shared/types';

/** Hard cap on a report's date span so a single synchronous call stays bounded. */
export const MAX_REPORT_RANGE_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reports domain Lambda — generate an AI progress report for a cared-for user, list a
 * user's reports, mint a presigned download URL for one, and delete one. Routed by
 * fieldName. Authorization for all four is the single seam assertCanAccessUserReports.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<Report | Connection<Report> | MediaDownloadTarget | boolean> => {
  const callerId = requireCaller(event.identity);
  const { arguments: args } = event;

  switch (event.info?.fieldName) {
    case 'generateReport':
      return generateReport(callerId, args.input as GenerateReportInput);
    case 'listReports': {
      const userId = (args.userId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      await assertCanAccessUserReports(callerId, userId);
      return listReports(userId, pageArgs(args));
    }
    case 'getReportDownloadUrl': {
      const userId = (args.userId as string)?.trim();
      const reportId = (args.reportId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      if (!reportId) throw new ValidationError('reportId is required');
      await assertCanAccessUserReports(callerId, userId);
      return getReportDownloadUrl(userId, reportId);
    }
    case 'deleteReport': {
      const userId = (args.userId as string)?.trim();
      const reportId = (args.reportId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      if (!reportId) throw new ValidationError('reportId is required');
      await assertCanAccessUserReports(callerId, userId);
      return deleteReport(userId, reportId);
    }
    default:
      throw new Error(`reports handler: unsupported field "${event.info?.fieldName}"`);
  }
};

async function generateReport(callerId: string, input: GenerateReportInput): Promise<Report> {
  const userId = input?.userId?.trim();
  const from = input?.from?.trim();
  const to = input?.to?.trim();
  if (!userId) throw new ValidationError('userId is required');
  if (!from || !DATE_RE.test(from)) throw new ValidationError('from must be a YYYY-MM-DD date');
  if (!to || !DATE_RE.test(to)) throw new ValidationError('to must be a YYYY-MM-DD date');
  if (from > to) throw new ValidationError('from must be on or before to');
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (spanDays > MAX_REPORT_RANGE_DAYS) {
    throw new ValidationError(`date range must be at most ${MAX_REPORT_RANGE_DAYS} days`);
  }

  await assertCanAccessUserReports(callerId, userId);

  // Compute stats, then generate the narrative. Both must succeed BEFORE we persist, so a
  // Bedrock failure leaves nothing written (no half-saved report).
  const stats = await buildReportStats(userId, from, to);
  const narrative = await generateReportNarrative(stats);

  const reportId = randomUUID();
  const createdAt = new Date().toISOString();
  const doc: ReportDocument = {
    reportId,
    scope: { userId },
    dateRange: { from, to },
    createdBy: callerId,
    createdAt,
    stats,
    narrative,
  };

  // persist defaults to true; only an explicit `false` skips the S3 + DynamoDB write.
  const persist = input?.persist !== false;
  const report: Report = persist
    ? await writeReport(doc)
    : { reportId, scope: doc.scope, dateRange: doc.dateRange, createdBy: callerId, createdAt };

  console.log(
    JSON.stringify({
      event: 'generateReport',
      callerId,
      userId,
      from,
      to,
      reportId,
      persist,
      totalInstances: stats.meta.totalInstances,
    }),
  );

  // Return narrative + stats inline (computed in memory) so the caller can render the report
  // without a follow-up download — and so persist:false, which writes no s3Key, is still usable.
  return { ...report, narrative, stats };
}
