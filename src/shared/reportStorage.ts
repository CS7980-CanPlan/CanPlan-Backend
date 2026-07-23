import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { dynamo, TABLE_NAME } from './dynamodb';
import { queryAll } from './batch';
import { ENTITY, REPORT_PREFIX, reportSk, userPk } from './keys';
import { queryPage, type PageArgs } from './pagination';
import { renderReportPdf } from './reportPdf';
import { NotFoundError, ValidationError } from './response';
import { s3, MEDIA_BUCKET, DOWNLOAD_URL_TTL_SECONDS } from './s3';
import type {
  Connection,
  MediaDownloadTarget,
  Report,
  ReportDocument,
  SupportedReportFilterInput,
} from './types';

/** Bounded, predictable page sizes for the cross-user report feed. */
export const DEFAULT_SUPPORTED_REPORT_PAGE_SIZE = 20;
export const MAX_SUPPORTED_REPORT_PAGE_SIZE = 100;
const REPORT_QUERY_CONCURRENCY = 10;
const SUPPORTED_REPORT_CURSOR_VERSION = 1;
const REPORT_DELETION_PREFIX = 'REPORT_DELETION#';

interface SupportedReportCursor {
  v: typeof SUPPORTED_REPORT_CURSOR_VERSION;
  /** Last emitted chronological Report SK. */
  lastSk: string;
  /** Tie-breaker when two users happen to hold an identical Report SK. */
  lastUserId: string;
  /** Digest of user/date filters; prevents reusing a cursor with a different query. */
  filterDigest: string;
}

interface StoredReport extends Report {
  PK: string;
  SK: string;
  entityType?: string;
}

interface ReportCandidate {
  report: Report;
  sk: string;
  userId: string;
}

interface PartitionCandidates {
  candidates: ReportCandidate[];
  hasUnevaluatedItems: boolean;
}

/**
 * Durable cleanup state written before a Report row is removed. It carries only deterministic,
 * server-derived keys and remains until both private S3 objects have been deleted, allowing an
 * interrupted delete to resume even though the chronological Report row is already gone.
 */
interface ReportDeletionJournal {
  PK: string;
  SK: string;
  userId: string;
  reportId: string;
  reportCreatedAt: string;
  reportRowSk: string;
  jsonKey: string;
  pdfKey: string;
  createdAt: string;
}

/** Deterministic, server-owned S3 key for one report's JSON document. */
export const reportS3Key = (userId: string, reportId: string): string =>
  `reports/${userId}/${reportId}.json`;

/** Deterministic, server-owned cache key for one saved report's generated PDF. */
export const reportPdfS3Key = (userId: string, reportId: string): string =>
  `report-pdf-cache/${userId}/${reportId}.pdf`;

/** Deterministic journal key for a report deletion that may need S3 cleanup retries. */
export const reportDeletionJournalSk = (reportId: string): string =>
  `${REPORT_DELETION_PREFIX}${reportId}`;

/**
 * Persist a report: write the JSON to S3 FIRST, then the DynamoDB index row. This order
 * means the index never points at a missing object (a failed S3 write throws before any
 * row is written). Returns the metadata row (scope/dateRange as plain objects; AppSync
 * serializes them to AWSJSON).
 */
export async function writeReport(doc: ReportDocument): Promise<Report> {
  const s3Key = reportS3Key(doc.scope.userId, doc.reportId);
  await s3.send(
    new PutObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(doc),
      ContentType: 'application/json',
    }),
  );

  const report: Report = {
    reportId: doc.reportId,
    scope: doc.scope,
    dateRange: doc.dateRange,
    s3Key,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(doc.scope.userId),
        SK: reportSk(doc.createdAt, doc.reportId),
        entityType: ENTITY.REPORT,
        ...report,
      },
    }),
  );

  return report;
}

/** List a user's reports, newest-first (the SK is chronological, so scan descending). */
export async function listReports(userId: string, page: PageArgs): Promise<Connection<Report>> {
  return queryPage<Report>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': REPORT_PREFIX },
      ScanIndexForward: false,
    },
    page,
  );
}

/**
 * List reports across a caller's CURRENTLY accessible primary-user partitions, newest-first.
 *
 * DynamoDB has no join between SupportLinks and Reports, so authorization resolves the allowed
 * user ids before calling this function. We issue one bounded base-table Query per allowed user,
 * then perform a deterministic k-way merge ordered by (Report SK descending, userId ascending).
 * Querying at most pageSize+1 rows from each partition is sufficient to identify the next global
 * page without reading unrelated users or adding a broad reports GSI.
 *
 * Pagination is stateless: the cursor stores the last global sort position. On the next call,
 * every partition resumes at or below that position and the already-emitted boundary row is
 * removed according to the userId tie-break. The cursor is bound to the normalized filter.
 */
export async function listMySupportedUserReports(
  accessibleUserIds: string[],
  filter: SupportedReportFilterInput,
  page: PageArgs,
): Promise<Connection<Report>> {
  const pageSize = supportedReportPageSize(page.limit);
  const digest = supportedReportFilterDigest(filter);
  const cursor = decodeSupportedReportCursor(page.nextToken, digest);
  const userIds = [...new Set(accessibleUserIds.map((id) => id.trim()).filter(Boolean))].sort();

  if (userIds.length === 0) return { items: [], nextToken: null };

  const partitions: PartitionCandidates[] = [];
  for (let i = 0; i < userIds.length; i += REPORT_QUERY_CONCURRENCY) {
    const chunk = userIds.slice(i, i + REPORT_QUERY_CONCURRENCY);
    partitions.push(
      ...(await Promise.all(
        chunk.map((userId) => queryReportCandidates(userId, filter, cursor, pageSize + 1)),
      )),
    );
  }

  const candidates = partitions
    .flatMap((partition) => partition.candidates)
    .sort(compareReportCandidates);
  const emitted = candidates.slice(0, pageSize);
  const hasMore =
    candidates.length > pageSize || partitions.some((partition) => partition.hasUnevaluatedItems);
  const last = emitted.at(-1);

  return {
    items: emitted.map((candidate) => candidate.report),
    nextToken:
      hasMore && last
        ? encodeSupportedReportCursor({
            v: SUPPORTED_REPORT_CURSOR_VERSION,
            lastSk: last.sk,
            lastUserId: last.userId,
            filterDigest: digest,
          })
        : null,
  };
}

async function queryReportCandidates(
  userId: string,
  filter: SupportedReportFilterInput,
  cursor: SupportedReportCursor | undefined,
  limit: number,
): Promise<PartitionCandidates> {
  const lower = filter.createdFrom ? `${REPORT_PREFIX}${filter.createdFrom}` : REPORT_PREFIX;
  const dateUpper = filter.createdTo
    ? `${REPORT_PREFIX}${filter.createdTo}\uffff`
    : `${REPORT_PREFIX}\uffff`;
  const upper = cursor && cursor.lastSk < dateUpper ? cursor.lastSk : dateUpper;
  if (upper < lower) return { candidates: [], hasUnevaluatedItems: false };

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lower AND :upper',
      ExpressionAttributeValues: {
        ':pk': userPk(userId),
        ':lower': lower,
        ':upper': upper,
      },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: limit,
    }),
  );

  const candidates = ((result.Items as StoredReport[]) ?? [])
    .filter((row) => {
      if (!cursor || row.SK !== cursor.lastSk) return true;
      // Global tie order is userId ascending. Same-SK rows on users after the cursor user have
      // not been emitted yet; the cursor user's row and users before it have.
      return userId > cursor.lastUserId;
    })
    .map((row): ReportCandidate => {
      const report = { ...row } as Record<string, unknown>;
      const sk = row.SK;
      delete report.PK;
      delete report.SK;
      delete report.entityType;
      return { report: report as unknown as Report, sk, userId };
    });

  return {
    candidates,
    hasUnevaluatedItems: Boolean(result.LastEvaluatedKey),
  };
}

function compareReportCandidates(a: ReportCandidate, b: ReportCandidate): number {
  if (a.sk !== b.sk) return a.sk > b.sk ? -1 : 1;
  if (a.userId === b.userId) return 0;
  return a.userId < b.userId ? -1 : 1;
}

function supportedReportPageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SUPPORTED_REPORT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SUPPORTED_REPORT_PAGE_SIZE) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MAX_SUPPORTED_REPORT_PAGE_SIZE}`,
    );
  }
  return limit;
}

function supportedReportFilterDigest(filter: SupportedReportFilterInput): string {
  const canonical = JSON.stringify({
    userId: filter.userId ?? null,
    createdFrom: filter.createdFrom ?? null,
    createdTo: filter.createdTo ?? null,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

function encodeSupportedReportCursor(cursor: SupportedReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeSupportedReportCursor(
  token: string | undefined,
  expectedFilterDigest: string,
): SupportedReportCursor | undefined {
  if (!token) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    ) as Partial<SupportedReportCursor>;
    if (
      value.v !== SUPPORTED_REPORT_CURSOR_VERSION ||
      typeof value.lastSk !== 'string' ||
      !value.lastSk.startsWith(REPORT_PREFIX) ||
      typeof value.lastUserId !== 'string' ||
      !value.lastUserId ||
      typeof value.filterDigest !== 'string'
    ) {
      throw new Error('invalid cursor shape');
    }
    if (value.filterDigest !== expectedFilterDigest) {
      throw new ValidationError('nextToken does not match the current report filters');
    }
    return value as SupportedReportCursor;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('invalid nextToken');
  }
}

/**
 * Presigned GET for one report's JSON. Looks the row up (so we only ever sign keys that
 * exist — no arbitrary-key probing), matching it by reportId within the user's reports.
 */
export async function getReportDownloadUrl(
  userId: string,
  reportId: string,
): Promise<MediaDownloadTarget> {
  const report = await findSavedReport(userId, reportId);
  const s3Key = assertServerOwnedReportKey(report, userId, reportId);

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: s3Key }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
  return { downloadUrl, s3Key, expiresIn: DOWNLOAD_URL_TTL_SECONDS };
}

/**
 * Generate a PDF from the immutable, server-written JSON report document, place it at a
 * deterministic private cache key, and return a short-lived presigned attachment URL.
 *
 * Authorization happens in the reports handler before this storage function is entered. This
 * layer still fails closed if either the index row or JSON document does not match the requested
 * user/report pair. No client-supplied S3 key, filename, or report content is trusted.
 */
export async function getReportPdfDownloadUrl(
  userId: string,
  reportId: string,
): Promise<MediaDownloadTarget> {
  const report = await findSavedReport(userId, reportId);
  const jsonKey = assertServerOwnedReportKey(report, userId, reportId);
  const object = await s3.send(new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: jsonKey }));
  if (!object.Body) throw new Error('saved report document is empty');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.Body.transformToString());
  } catch {
    throw new Error('saved report document is invalid JSON');
  }
  const document = validateReportDocument(parsed, report, userId, reportId);
  const pdfBytes = await renderReportPdf(document);
  const pdfKey = reportPdfS3Key(userId, reportId);
  const contentDisposition = reportPdfContentDisposition(document);

  await s3.send(
    new PutObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: pdfKey,
      Body: pdfBytes,
      ContentType: 'application/pdf',
      ContentDisposition: contentDisposition,
      CacheControl: 'private, no-store',
    }),
  );

  // Deletion may have removed the index row (and its cache object) while the JSON was being
  // rendered. Re-read strongly after the PUT so that this request cannot recreate an orphaned
  // PDF after deleteReport has completed.
  const currentReport = await findSavedReportOrUndefined(userId, reportId);
  if (!currentReport) {
    await removeGeneratedPdfAfterDeleteRace(pdfKey);
    throw new NotFoundError('report not found');
  }
  try {
    assertSameSavedReport(currentReport, report, userId, reportId);
  } catch (error) {
    await removeGeneratedPdfAfterDeleteRace(pdfKey);
    throw error;
  }

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: pdfKey,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: contentDisposition,
      ResponseCacheControl: 'private, no-store',
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
  return { downloadUrl, s3Key: pdfKey, expiresIn: DOWNLOAD_URL_TTL_SECONDS };
}

/**
 * Delete a persisted report with a durable, deterministic cleanup journal. The journal is written
 * before the chronological Report row is removed, so a retry can still discover the exact
 * server-owned JSON/PDF keys after a partial S3 failure. The journal is removed only after both
 * idempotent S3 deletes succeed.
 */
export async function deleteReport(userId: string, reportId: string): Promise<boolean> {
  const journal = await prepareReportDeletion(userId, reportId);
  await Promise.all([
    s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: journal.jsonKey })),
    s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: journal.pdfKey })),
  ]);
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: journal.PK, SK: journal.SK },
    }),
  );
  return true;
}

/**
 * Create cleanup state before removing a live Report row, or resume the state left by an earlier
 * partial delete. Journal contents are validated against deterministic keys before they are used
 * for S3 deletion, so a corrupt row cannot turn into an arbitrary-key delete primitive.
 */
async function prepareReportDeletion(
  userId: string,
  reportId: string,
): Promise<ReportDeletionJournal> {
  const report = await findSavedReportOrUndefined(userId, reportId);
  if (!report) {
    const result = await dynamo.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: reportDeletionJournalSk(reportId) },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) throw new NotFoundError('report not found');
    return validateReportDeletionJournal(result.Item, userId, reportId);
  }

  const jsonKey = assertServerOwnedReportKey(report, userId, reportId);
  if (typeof report.createdAt !== 'string' || !report.createdAt) {
    throw new Error('saved report metadata does not match the requested report');
  }
  const journal: ReportDeletionJournal = {
    PK: userPk(userId),
    SK: reportDeletionJournalSk(reportId),
    userId,
    reportId,
    reportCreatedAt: report.createdAt,
    reportRowSk: reportSk(report.createdAt, reportId),
    jsonKey,
    pdfKey: reportPdfS3Key(userId, reportId),
    createdAt: new Date().toISOString(),
  };

  await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: journal }));
  await dynamo.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: journal.PK, SK: journal.reportRowSk },
    }),
  );
  return journal;
}

/**
 * Strongly-consistent saved-row lookup shared by JSON download, PDF generation, and deletion.
 * A report is written to S3 before its row, so this avoids an immediate post-save navigation
 * missing a row because of an eventually-consistent base-table read.
 */
async function findSavedReport(userId: string, reportId: string): Promise<Report> {
  const report = await findSavedReportOrUndefined(userId, reportId);
  if (!report) throw new NotFoundError('report not found');
  return report;
}

async function findSavedReportOrUndefined(
  userId: string,
  reportId: string,
): Promise<Report | undefined> {
  const reports = await queryAll<Report>({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': REPORT_PREFIX },
    ConsistentRead: true,
  });
  return reports.find((candidate) => candidate.reportId === reportId);
}

function assertServerOwnedReportKey(report: Report, userId: string, reportId: string): string {
  const expectedKey = reportS3Key(userId, reportId);
  if (
    report.reportId !== reportId ||
    report.scope?.userId !== userId ||
    report.s3Key !== expectedKey
  ) {
    throw new Error('saved report metadata does not match the requested report');
  }
  return expectedKey;
}

function assertSameSavedReport(
  current: Report,
  expected: Report,
  userId: string,
  reportId: string,
): void {
  assertServerOwnedReportKey(current, userId, reportId);
  if (
    current.createdAt !== expected.createdAt ||
    current.createdBy !== expected.createdBy ||
    current.dateRange?.from !== expected.dateRange?.from ||
    current.dateRange?.to !== expected.dateRange?.to
  ) {
    throw new Error('saved report metadata changed while generating PDF');
  }
}

async function removeGeneratedPdfAfterDeleteRace(pdfKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: pdfKey }));
  } catch (error) {
    // Preserve the required NotFound result. The deterministic cache prefix also has a lifecycle
    // backstop, while logging keeps an unexpected cleanup failure observable.
    console.error(
      JSON.stringify({
        event: 'reportPdfDeleteRaceCleanupFailed',
        pdfKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function validateReportDeletionJournal(
  value: unknown,
  userId: string,
  reportId: string,
): ReportDeletionJournal {
  if (!isRecord(value)) throw new Error('saved report deletion journal has an invalid shape');
  const reportCreatedAt = value.reportCreatedAt;
  const expectedPk = userPk(userId);
  const expectedSk = reportDeletionJournalSk(reportId);
  const expectedJsonKey = reportS3Key(userId, reportId);
  const expectedPdfKey = reportPdfS3Key(userId, reportId);
  if (
    value.PK !== expectedPk ||
    value.SK !== expectedSk ||
    value.userId !== userId ||
    value.reportId !== reportId ||
    typeof reportCreatedAt !== 'string' ||
    !reportCreatedAt ||
    value.reportRowSk !== reportSk(reportCreatedAt, reportId) ||
    value.jsonKey !== expectedJsonKey ||
    value.pdfKey !== expectedPdfKey ||
    typeof value.createdAt !== 'string' ||
    !value.createdAt
  ) {
    throw new Error('saved report deletion journal does not match the requested report');
  }
  return value as unknown as ReportDeletionJournal;
}

function validateReportDocument(
  value: unknown,
  report: Report,
  userId: string,
  reportId: string,
): ReportDocument {
  if (!isRecord(value)) throw new Error('saved report document has an invalid shape');
  const scope = value.scope;
  const dateRange = value.dateRange;
  const stats = value.stats;
  if (
    value.reportId !== reportId ||
    !isRecord(scope) ||
    scope.userId !== userId ||
    !isRecord(dateRange) ||
    typeof dateRange.from !== 'string' ||
    typeof dateRange.to !== 'string' ||
    dateRange.from !== report.dateRange?.from ||
    dateRange.to !== report.dateRange?.to ||
    value.createdBy !== report.createdBy ||
    value.createdAt !== report.createdAt ||
    typeof value.createdBy !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.narrative !== 'string' ||
    !isCompleteReportStats(stats, userId, dateRange.from, dateRange.to)
  ) {
    throw new Error('saved report document does not match its report metadata');
  }
  return value as unknown as ReportDocument;
}

function isCompleteReportStats(value: unknown, userId: string, from: string, to: string): boolean {
  if (!isRecord(value)) return false;
  const meta = value.meta;
  const completion = value.completion;
  const focus = value.focus;
  const skipPatterns = value.skipPatterns;
  return (
    isRecord(meta) &&
    meta.userId === userId &&
    meta.from === from &&
    meta.to === to &&
    meta.basis === 'attempted-instances-only' &&
    typeof meta.totalInstances === 'number' &&
    isRecord(completion) &&
    Array.isArray(value.trend) &&
    Array.isArray(value.byCategory) &&
    Array.isArray(value.byTask) &&
    Array.isArray(value.stepDwell) &&
    isRecord(focus) &&
    Array.isArray(focus.byTask) &&
    isRecord(skipPatterns) &&
    Array.isArray(skipPatterns.byTask) &&
    Array.isArray(skipPatterns.byHour) &&
    Array.isArray(value.abandonment) &&
    Array.isArray(value.timeOfDay)
  );
}

function reportPdfContentDisposition(document: ReportDocument): string {
  const from = safeFilePart(document.dateRange.from);
  const to = safeFilePart(document.dateRange.to);
  const reportId = safeFilePart(document.reportId);
  return `attachment; filename="canplan-report-${from}-to-${to}-${reportId}.pdf"`;
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return safe || 'unknown-date';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
