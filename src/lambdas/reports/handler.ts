import { randomUUID } from 'crypto';
import { requireCaller } from '../../shared/authz';
import { pageArgs } from '../../shared/pagination';
import { buildReportStats } from '../../shared/reportMetrics';
import { assertCanAccessUserReports, listAccessibleReportUserIds } from '../../shared/reportAuthz';
import {
  signReportDraft,
  verifyReportDraft,
  type ReportDraftContent,
} from '../../shared/reportDraftToken';
import { generateReportNarrative } from '../../shared/reportNarrative';
import {
  deleteReport,
  getReportDownloadUrl,
  getReportPdfDownloadUrl,
  listMySupportedUserReports,
  listReports,
  writeReport,
} from '../../shared/reportStorage';
import { ValidationError } from '../../shared/response';
import type {
  AppSyncEvent,
  Connection,
  GeneratedReport,
  GenerateReportInput,
  MediaDownloadTarget,
  Report,
  ReportDocument,
  ReportStats,
  SaveReportInput,
  SupportedReportFilterInput,
} from '../../shared/types';

type NullableSupportedReportFilterInput = {
  [K in keyof SupportedReportFilterInput]?: SupportedReportFilterInput[K] | null;
};

/** Hard cap on a report's date span so a single synchronous call stays bounded. */
export const MAX_REPORT_RANGE_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reports domain Lambda. The report lifecycle is two steps:
 *   - generateReport — compute deterministic stats + AI narrative in memory, sign a draft
 *     token, and return the content inline. Writes NOTHING (no S3, no DynamoDB, no Bedrock beyond
 *     the narrative).
 *   - saveReport — verify the signed draft token against the re-submitted content, then persist
 *     it (S3 JSON + DynamoDB index row). Recomputes no stats and calls no model.
 * Plus per-user and cross-supported-user listing, getReportDownloadUrl, and deleteReport over
 * saved reports. Routed by fieldName; authorization stays behind the reportAuthz seam.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<GeneratedReport | Report | Connection<Report> | MediaDownloadTarget | boolean> => {
  // Reject an unauthenticated caller up front, before any routing or work.
  requireCaller(event.identity);
  const { arguments: args } = event;

  switch (event.info?.fieldName) {
    case 'generateReport':
      return generateReport(event.identity, args.input as GenerateReportInput);
    case 'saveReport':
      return saveReport(event.identity, args.input as SaveReportInput);
    case 'listReports': {
      const userId = (args.userId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      await assertCanAccessUserReports(event.identity, userId);
      return listReports(userId, pageArgs(args));
    }
    case 'listMySupportedUserReports': {
      const filter = normalizeSupportedReportFilter(
        args.filter as NullableSupportedReportFilterInput | null | undefined,
      );
      // A selected-user query can fail fast through the normal per-user authorization seam.
      // The all-users feed resolves every currently effective link in one batch-oriented pass.
      const userIds = filter.userId
        ? [filter.userId]
        : await listAccessibleReportUserIds(event.identity);
      if (filter.userId) {
        await assertCanAccessUserReports(event.identity, filter.userId);
      }
      return listMySupportedUserReports(userIds, filter, pageArgs(args));
    }
    case 'getReportDownloadUrl': {
      const userId = (args.userId as string)?.trim();
      const reportId = (args.reportId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      if (!reportId) throw new ValidationError('reportId is required');
      await assertCanAccessUserReports(event.identity, userId);
      return getReportDownloadUrl(userId, reportId);
    }
    case 'getReportPdfDownloadUrl': {
      const userId = (args.userId as string)?.trim();
      const reportId = (args.reportId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      if (!reportId) throw new ValidationError('reportId is required');
      await assertCanAccessUserReports(event.identity, userId);
      return getReportPdfDownloadUrl(userId, reportId);
    }
    case 'deleteReport': {
      const userId = (args.userId as string)?.trim();
      const reportId = (args.reportId as string)?.trim();
      if (!userId) throw new ValidationError('userId is required');
      if (!reportId) throw new ValidationError('reportId is required');
      await assertCanAccessUserReports(event.identity, userId);
      return deleteReport(userId, reportId);
    }
    default:
      throw new Error(`reports handler: unsupported field "${event.info?.fieldName}"`);
  }
};

/** Validate and canonicalize optional saved-at filters before they are cursor-bound. */
function normalizeSupportedReportFilter(
  input: NullableSupportedReportFilterInput | null | undefined,
): SupportedReportFilterInput {
  const filter = input ?? {};
  const userId = filter.userId == null ? undefined : filter.userId.trim();
  if (filter.userId != null && !userId) {
    throw new ValidationError('filter.userId cannot be empty');
  }

  const createdFrom = normalizeAwsDateTime(filter.createdFrom, 'filter.createdFrom');
  const createdTo = normalizeAwsDateTime(filter.createdTo, 'filter.createdTo');
  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw new ValidationError('filter.createdFrom must be on or before filter.createdTo');
  }

  return { userId, createdFrom, createdTo };
}

function normalizeAwsDateTime(value: string | null | undefined, field: string): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  if (!trimmed || !Number.isFinite(timestamp)) {
    throw new ValidationError(`${field} must be a valid AWSDateTime`);
  }
  return new Date(timestamp).toISOString();
}

/**
 * Compute the report's deterministic stats and AI narrative and return them inline with a
 * signed draft token. Persists nothing — the caller reviews the preview, then calls saveReport
 * with this exact content (and the token) to keep it.
 */
async function generateReport(
  identity: AppSyncEvent['identity'],
  input: GenerateReportInput,
): Promise<GeneratedReport> {
  const userId = input?.userId?.trim();
  const from = input?.from?.trim();
  const to = input?.to?.trim();
  if (!userId) throw new ValidationError('userId is required');
  if (!from || !DATE_RE.test(from)) throw new ValidationError('from must be a YYYY-MM-DD date');
  if (!to || !DATE_RE.test(to)) throw new ValidationError('to must be a YYYY-MM-DD date');
  if (from > to) throw new ValidationError('from must be on or before to');
  const inclusiveDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (inclusiveDays > MAX_REPORT_RANGE_DAYS) {
    throw new ValidationError(`date range must be at most ${MAX_REPORT_RANGE_DAYS} days`);
  }

  await assertCanAccessUserReports(identity, userId);

  const stats = await buildReportStats(userId, from, to);
  const narrative = await generateReportNarrative(stats);
  const generatedAt = new Date().toISOString();

  // Bind the exact produced content into a server-signed token so saveReport can prove the
  // client is persisting what we generated (nothing tampered, not expired).
  const content: ReportDraftContent = { userId, from, to, generatedAt, narrative, stats };
  const draftToken = signReportDraft(content);

  console.log(
    JSON.stringify({
      event: 'generateReport',
      userId,
      from,
      to,
      generatedAt,
      totalInstances: stats.meta.totalInstances,
    }),
  );

  return {
    draftToken,
    scope: { userId },
    dateRange: { from, to },
    generatedAt,
    narrative,
    stats,
  };
}

/**
 * Persist a previously generated report. Verifies the signed draft token against the
 * re-submitted content (rejecting stale/expired/tampered drafts), authorizes the caller against
 * the token's signed userId, then writes it via writeReport. Recomputes no stats; calls no model.
 */
async function saveReport(
  identity: AppSyncEvent['identity'],
  input: SaveReportInput,
): Promise<Report> {
  const draftToken = input?.draftToken?.trim();
  if (!draftToken) throw new ValidationError('draftToken is required');

  const userId = input?.scope?.userId?.trim();
  const from = input?.dateRange?.from?.trim();
  const to = input?.dateRange?.to?.trim();
  const generatedAt = input?.generatedAt?.trim();
  const narrative = input?.narrative;
  const stats = input?.stats as ReportStats | undefined;

  if (!userId) throw new ValidationError('scope.userId is required');
  if (!from || !DATE_RE.test(from))
    throw new ValidationError('dateRange.from must be a YYYY-MM-DD date');
  if (!to || !DATE_RE.test(to)) throw new ValidationError('dateRange.to must be a YYYY-MM-DD date');
  if (!generatedAt) throw new ValidationError('generatedAt is required');
  if (typeof narrative !== 'string' || !narrative)
    throw new ValidationError('narrative is required');
  if (!stats || typeof stats !== 'object') throw new ValidationError('stats is required');

  // Verify the token binds exactly this content and has not expired. Throws on any mismatch.
  const content: ReportDraftContent = { userId, from, to, generatedAt, narrative, stats };
  const payload = verifyReportDraft(draftToken, content);

  // Authorize against the SIGNED userId (which the hash guarantees equals content.userId).
  const callerId = await assertCanAccessUserReports(identity, payload.userId);

  const reportId = randomUUID();
  const createdAt = new Date().toISOString();
  const doc: ReportDocument = {
    reportId,
    scope: { userId: payload.userId },
    dateRange: { from: payload.from, to: payload.to },
    createdBy: callerId,
    createdAt,
    stats,
    narrative,
  };
  const report = await writeReport(doc);

  console.log(
    JSON.stringify({
      event: 'saveReport',
      callerId,
      userId: payload.userId,
      from: payload.from,
      to: payload.to,
      reportId,
    }),
  );

  // Echo the content inline (the client already has it) so the saved Report renders without a
  // follow-up download.
  return { ...report, narrative, stats };
}
