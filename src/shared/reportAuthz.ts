import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './dynamodb';
import { supporterPk, userLinkSk } from './keys';
import { UnauthorizedError } from './response';
import type { SupportLink } from './types';

/**
 * Authorization seam for the reports feature — guards generateReport, listReports, and
 * getReportDownloadUrl. INTERIM IMPLEMENTATION: the caller must hold an ACTIVE SupportLink
 * to the primary user. When the team's general permission model lands, replace ONLY the
 * body of this function (e.g. check a granular "reports" permission); callers don't change.
 */
export async function assertCanAccessUserReports(
  callerId: string,
  primaryUserId: string,
): Promise<void> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: supporterPk(callerId), SK: userLinkSk(primaryUserId) },
    }),
  );
  const link = result.Item as SupportLink | undefined;
  if (!link || link.status !== 'ACTIVE') {
    throw new UnauthorizedError('Unauthorized: no active support link to this user');
  }
}
