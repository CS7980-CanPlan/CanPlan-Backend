import { writeReport, listReports, getReportDownloadUrl, reportS3Key } from './reportStorage';
import { dynamo } from './dynamodb';
import { s3 } from './s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ReportDocument } from './types';

jest.mock('./dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'T' }));
jest.mock('./s3', () => ({
  s3: { send: jest.fn() },
  MEDIA_BUCKET: 'bucket',
  DOWNLOAD_URL_TTL_SECONDS: 900,
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const mockDynamo = dynamo.send as jest.Mock;
const mockS3 = s3.send as jest.Mock;
const mockSign = getSignedUrl as jest.Mock;

const DOC: ReportDocument = {
  reportId: 'r-1',
  scope: { userId: 'u1' },
  dateRange: { from: '2026-06-01', to: '2026-06-30' },
  createdBy: 'sup-1',
  createdAt: '2026-06-30T12:00:00.000Z',
  stats: {} as ReportDocument['stats'],
  narrative: 'ok',
};

afterEach(() => jest.clearAllMocks());

describe('reportS3Key', () => {
  it('is deterministic under the reports/ prefix', () => {
    expect(reportS3Key('u1', 'r-1')).toBe('reports/u1/r-1.json');
  });
});

describe('writeReport', () => {
  it('PUTs the S3 object first, then the DynamoDB row, returning the metadata', async () => {
    mockS3.mockResolvedValue({});
    mockDynamo.mockResolvedValue({});
    const report = await writeReport(DOC);
    expect(mockS3).toHaveBeenCalledTimes(1);
    expect(mockDynamo).toHaveBeenCalledTimes(1);
    expect(report).toEqual({
      reportId: 'r-1',
      scope: JSON.stringify({ userId: 'u1' }),
      dateRange: JSON.stringify({ from: '2026-06-01', to: '2026-06-30' }),
      s3Key: 'reports/u1/r-1.json',
      createdBy: 'sup-1',
      createdAt: '2026-06-30T12:00:00.000Z',
    });
    // DynamoDB item is keyed under the user partition with a chronological report SK.
    const item = mockDynamo.mock.calls[0][0].input.Item;
    expect(item.PK).toBe('USER#u1');
    expect(item.SK).toBe('REPORT#2026-06-30T12:00:00.000Z#r-1');
  });
});

describe('getReportDownloadUrl', () => {
  it('finds the report row then signs its s3Key', async () => {
    mockDynamo.mockResolvedValue({
      Items: [{ reportId: 'r-1', s3Key: 'reports/u1/r-1.json' }],
    });
    mockSign.mockResolvedValue('https://signed');
    const out = await getReportDownloadUrl('u1', 'r-1');
    expect(out).toEqual({ downloadUrl: 'https://signed', s3Key: 'reports/u1/r-1.json', expiresIn: 900 });
  });

  it('throws NotFound when the report does not exist', async () => {
    mockDynamo.mockResolvedValue({ Items: [] });
    await expect(getReportDownloadUrl('u1', 'missing')).rejects.toThrow('not found');
  });
});

describe('listReports', () => {
  it('queries the user partition by the REPORT# prefix', async () => {
    mockDynamo.mockResolvedValue({ Items: [{ reportId: 'r-1' }], LastEvaluatedKey: undefined });
    const out = await listReports('u1', {});
    expect(out.items).toHaveLength(1);
    const input = mockDynamo.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues[':pk']).toBe('USER#u1');
    expect(input.ExpressionAttributeValues[':prefix']).toBe('REPORT#');
  });
});
