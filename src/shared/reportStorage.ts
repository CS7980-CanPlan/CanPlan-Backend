import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { dynamo, TABLE_NAME } from './dynamodb';
import { queryAll } from './batch';
import { ENTITY, REPORT_PREFIX, reportSk, userPk } from './keys';
import { queryPage, type PageArgs } from './pagination';
import { NotFoundError } from './response';
import { s3, MEDIA_BUCKET, DOWNLOAD_URL_TTL_SECONDS } from './s3';
import type { Connection, MediaDownloadTarget, Report, ReportDocument } from './types';

/** Deterministic, server-owned S3 key for one report's JSON document. */
export const reportS3Key = (userId: string, reportId: string): string =>
  `reports/${userId}/${reportId}.json`;

/**
 * Persist a report: write the JSON to S3 FIRST, then the DynamoDB index row. This order
 * means the index never points at a missing object (a failed S3 write throws before any
 * row is written). Returns the metadata row (scope/dateRange JSON-encoded for AWSJSON).
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
    scope: JSON.stringify(doc.scope),
    dateRange: JSON.stringify(doc.dateRange),
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
 * Presigned GET for one report's JSON. Looks the row up (so we only ever sign keys that
 * exist — no arbitrary-key probing), matching it by reportId within the user's reports.
 */
export async function getReportDownloadUrl(
  userId: string,
  reportId: string,
): Promise<MediaDownloadTarget> {
  const reports = await queryAll<Report>({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': REPORT_PREFIX },
  });
  const report = reports.find((r) => r.reportId === reportId);
  if (!report) throw new NotFoundError('report not found');

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: report.s3Key }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
  return { downloadUrl, s3Key: report.s3Key, expiresIn: DOWNLOAD_URL_TTL_SECONDS };
}
