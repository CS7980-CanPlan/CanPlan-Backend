import {
  writeReport,
  listReports,
  listMySupportedUserReports,
  getReportDownloadUrl,
  getReportPdfDownloadUrl,
  deleteReport,
  reportDeletionJournalSk,
  reportPdfS3Key,
  reportS3Key,
} from './reportStorage';
import { dynamo } from './dynamodb';
import { renderReportPdf } from './reportPdf';
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
jest.mock('./reportPdf', () => ({ renderReportPdf: jest.fn() }));

const mockDynamo = dynamo.send as jest.Mock;
const mockS3 = s3.send as jest.Mock;
const mockSign = getSignedUrl as jest.Mock;
const mockRenderPdf = renderReportPdf as jest.Mock;

const DOC: ReportDocument = {
  reportId: 'r-1',
  scope: { userId: 'u1' },
  dateRange: { from: '2026-06-01', to: '2026-06-30' },
  createdBy: 'sup-1',
  createdAt: '2026-06-30T12:00:00.000Z',
  stats: {
    meta: {
      userId: 'u1',
      from: '2026-06-01',
      to: '2026-06-30',
      basis: 'attempted-instances-only',
      totalInstances: 1,
    },
    completion: {
      completed: 1,
      skipped: 0,
      cancelled: 0,
      overdue: 0,
      inProgress: 0,
      toDo: 0,
      completionRate: 1,
    },
    trend: [],
    byCategory: [],
    byTask: [],
    stepDwell: [],
    focus: { byTask: [], focusRatio: null },
    skipPatterns: { byTask: [], byHour: new Array<number>(24).fill(0) },
    abandonment: [],
    timeOfDay: new Array<number>(24).fill(0),
  },
  narrative: 'ok',
};

afterEach(() => {
  mockDynamo.mockReset();
  mockS3.mockReset();
  mockSign.mockReset();
  mockRenderPdf.mockReset();
});

describe('reportS3Key', () => {
  it('is deterministic under the reports/ prefix', () => {
    expect(reportS3Key('u1', 'r-1')).toBe('reports/u1/r-1.json');
    expect(reportPdfS3Key('u1', 'r-1')).toBe('report-pdf-cache/u1/r-1.pdf');
    expect(reportDeletionJournalSk('r-1')).toBe('REPORT_DELETION#r-1');
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
      scope: { userId: 'u1' },
      dateRange: { from: '2026-06-01', to: '2026-06-30' },
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
      Items: [
        {
          reportId: 'r-1',
          scope: { userId: 'u1' },
          s3Key: 'reports/u1/r-1.json',
        },
      ],
    });
    mockSign.mockResolvedValue('https://signed');
    const out = await getReportDownloadUrl('u1', 'r-1');
    expect(out).toEqual({
      downloadUrl: 'https://signed',
      s3Key: 'reports/u1/r-1.json',
      expiresIn: 900,
    });
    expect(mockDynamo.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(mockSign.mock.calls[0][1].input.Key).toBe('reports/u1/r-1.json');
  });

  it('throws NotFound when the report does not exist', async () => {
    mockDynamo.mockResolvedValue({ Items: [] });
    await expect(getReportDownloadUrl('u1', 'missing')).rejects.toThrow('not found');
  });
});

describe('getReportPdfDownloadUrl', () => {
  const reportRow = {
    reportId: 'r-1',
    scope: { userId: 'u1' },
    dateRange: { from: '2026-06-01', to: '2026-06-30' },
    s3Key: 'reports/u1/r-1.json',
    createdBy: 'sup-1',
    createdAt: '2026-06-30T12:00:00.000Z',
  };

  it('loads the server-owned JSON, renders and stores a private attachment, then signs it', async () => {
    const pdfBytes = Uint8Array.from([37, 80, 68, 70]);
    mockDynamo.mockResolvedValue({ Items: [reportRow] });
    mockS3.mockImplementation((command: { constructor: { name: string } }) =>
      command.constructor.name === 'GetObjectCommand'
        ? Promise.resolve({
            Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(DOC)) },
          })
        : Promise.resolve({}),
    );
    mockRenderPdf.mockResolvedValue(pdfBytes);
    mockSign.mockResolvedValue('https://signed-pdf');

    const out = await getReportPdfDownloadUrl('u1', 'r-1');

    expect(out).toEqual({
      downloadUrl: 'https://signed-pdf',
      s3Key: 'report-pdf-cache/u1/r-1.pdf',
      expiresIn: 900,
    });
    expect(mockDynamo.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(mockDynamo).toHaveBeenCalledTimes(2);
    expect(mockDynamo.mock.calls[1][0].input.ConsistentRead).toBe(true);
    expect(mockS3.mock.calls[0][0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'reports/u1/r-1.json',
    });
    expect(mockRenderPdf).toHaveBeenCalledWith(DOC);
    expect(mockS3.mock.calls[1][0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'report-pdf-cache/u1/r-1.pdf',
      Body: pdfBytes,
      ContentType: 'application/pdf',
      ContentDisposition: 'attachment; filename="canplan-report-2026-06-01-to-2026-06-30-r-1.pdf"',
      CacheControl: 'private, no-store',
    });
    expect(mockSign.mock.calls[0][1].input).toMatchObject({
      Key: 'report-pdf-cache/u1/r-1.pdf',
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition:
        'attachment; filename="canplan-report-2026-06-01-to-2026-06-30-r-1.pdf"',
      ResponseCacheControl: 'private, no-store',
    });
  });

  it('removes the just-created PDF and returns NotFound when deletion wins the render race', async () => {
    const pdfBytes = Uint8Array.from([37, 80, 68, 70]);
    mockDynamo.mockResolvedValueOnce({ Items: [reportRow] }).mockResolvedValueOnce({ Items: [] });
    mockS3.mockImplementation((command: { constructor: { name: string } }) =>
      command.constructor.name === 'GetObjectCommand'
        ? Promise.resolve({
            Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(DOC)) },
          })
        : Promise.resolve({}),
    );
    mockRenderPdf.mockResolvedValue(pdfBytes);

    await expect(getReportPdfDownloadUrl('u1', 'r-1')).rejects.toThrow('not found');

    expect(mockDynamo).toHaveBeenCalledTimes(2);
    expect(mockDynamo.mock.calls[1][0].input.ConsistentRead).toBe(true);
    expect(mockS3.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'GetObjectCommand',
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
    expect(mockS3.mock.calls[2][0].input).toEqual({
      Bucket: 'bucket',
      Key: 'report-pdf-cache/u1/r-1.pdf',
    });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it.each([
    [
      'metadata key',
      { ...reportRow, s3Key: 'reports/u1/a-different-report.json' },
      DOC,
      'metadata',
    ],
    ['document id', reportRow, { ...DOC, reportId: 'r-2' }, 'does not match'],
    ['document scope', reportRow, { ...DOC, scope: { userId: 'another-user' } }, 'does not match'],
    [
      'document date range',
      reportRow,
      { ...DOC, dateRange: { from: '2026-05-01', to: '2026-06-30' } },
      'does not match',
    ],
  ])(
    'rejects a mismatched %s before rendering or signing',
    async (_case, row, document, message) => {
      mockDynamo.mockResolvedValue({ Items: [row] });
      mockS3.mockResolvedValue({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
      });

      await expect(getReportPdfDownloadUrl('u1', 'r-1')).rejects.toThrow(message);
      expect(mockRenderPdf).not.toHaveBeenCalled();
      expect(mockSign).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid stored JSON before rendering or overwriting the PDF cache', async () => {
    mockDynamo.mockResolvedValue({ Items: [reportRow] });
    mockS3.mockResolvedValue({
      Body: { transformToString: jest.fn().mockResolvedValue('{not json') },
    });

    await expect(getReportPdfDownloadUrl('u1', 'r-1')).rejects.toThrow('invalid JSON');
    expect(mockS3).toHaveBeenCalledTimes(1);
    expect(mockRenderPdf).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
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

describe('listMySupportedUserReports', () => {
  function row(userId: string, createdAt: string, reportId: string) {
    return {
      PK: `USER#${userId}`,
      SK: `REPORT#${createdAt}#${reportId}`,
      entityType: 'Report',
      reportId,
      scope: { userId },
      dateRange: { from: '2026-06-01', to: '2026-06-30' },
      s3Key: `reports/${userId}/${reportId}.json`,
      createdBy: 'sup-1',
      createdAt,
    };
  }

  function mockReportPartitions(rowsByUser: Record<string, ReturnType<typeof row>[]>) {
    mockDynamo.mockImplementation(
      (command: {
        constructor: { name: string };
        input: {
          ExpressionAttributeValues: Record<string, string>;
          Limit: number;
        };
      }) => {
        if (command.constructor.name !== 'QueryCommand') return Promise.resolve({});
        const values = command.input.ExpressionAttributeValues;
        const userId = String(values[':pk']).replace(/^USER#/, '');
        const matching = (rowsByUser[userId] ?? [])
          .filter((item) => item.SK >= values[':lower'] && item.SK <= values[':upper'])
          .sort((a, b) => (a.SK > b.SK ? -1 : a.SK < b.SK ? 1 : 0));
        const limit = command.input.Limit;
        return Promise.resolve({
          Items: matching.slice(0, limit),
          LastEvaluatedKey:
            matching.length > limit
              ? { PK: matching[limit - 1].PK, SK: matching[limit - 1].SK }
              : undefined,
        });
      },
    );
  }

  it('globally merges user partitions newest-first and resumes without duplicates', async () => {
    mockReportPartitions({
      'u-1': [
        row('u-1', '2026-07-05T12:00:00.000Z', 'r-5'),
        row('u-1', '2026-07-03T12:00:00.000Z', 'r-3'),
      ],
      'u-2': [
        row('u-2', '2026-07-04T12:00:00.000Z', 'r-4'),
        row('u-2', '2026-07-02T12:00:00.000Z', 'r-2'),
      ],
    });

    const first = await listMySupportedUserReports(['u-2', 'u-1'], {}, { limit: 3 });
    expect(first.items.map((report) => report.reportId)).toEqual(['r-5', 'r-4', 'r-3']);
    expect(first.nextToken).toEqual(expect.any(String));
    expect(first.items[0]).not.toHaveProperty('PK');
    expect(first.items[0]).not.toHaveProperty('SK');
    expect(first.items[0]).not.toHaveProperty('entityType');

    const second = await listMySupportedUserReports(
      ['u-2', 'u-1'],
      {},
      { limit: 3, nextToken: first.nextToken as string },
    );
    expect(second.items.map((report) => report.reportId)).toEqual(['r-2']);
    expect(second.nextToken).toBeNull();
  });

  it('uses userId as a stable tie-breaker for identical chronological keys', async () => {
    const timestamp = '2026-07-05T12:00:00.000Z';
    mockReportPartitions({
      'u-a': [row('u-a', timestamp, 'same-id')],
      'u-b': [row('u-b', timestamp, 'same-id')],
    });

    const first = await listMySupportedUserReports(['u-b', 'u-a'], {}, { limit: 1 });
    expect(first.items[0].scope.userId).toBe('u-a');

    const second = await listMySupportedUserReports(
      ['u-b', 'u-a'],
      {},
      { limit: 1, nextToken: first.nextToken as string },
    );
    expect(second.items.map((report) => report.scope.userId)).toEqual(['u-b']);
    expect(second.nextToken).toBeNull();
  });

  it('applies inclusive created-at bounds directly to every partition query', async () => {
    mockReportPartitions({
      'u-1': [
        row('u-1', '2026-07-03T00:00:00.000Z', 'after'),
        row('u-1', '2026-07-02T00:00:00.000Z', 'upper'),
        row('u-1', '2026-07-01T00:00:00.000Z', 'lower'),
        row('u-1', '2026-06-30T23:59:59.999Z', 'before'),
      ],
    });

    const result = await listMySupportedUserReports(
      ['u-1'],
      {
        createdFrom: '2026-07-01T00:00:00.000Z',
        createdTo: '2026-07-02T00:00:00.000Z',
      },
      {},
    );
    expect(result.items.map((report) => report.reportId)).toEqual(['upper', 'lower']);
    const input = mockDynamo.mock.calls[0][0].input;
    expect(input.ConsistentRead).toBe(true);
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':lower': 'REPORT#2026-07-01T00:00:00.000Z',
      ':upper': 'REPORT#2026-07-02T00:00:00.000Z\uffff',
    });
  });

  it('rejects a cursor reused with different filters before querying DynamoDB', async () => {
    mockReportPartitions({
      'u-1': [
        row('u-1', '2026-07-02T00:00:00.000Z', 'r-2'),
        row('u-1', '2026-07-01T00:00:00.000Z', 'r-1'),
      ],
    });
    const first = await listMySupportedUserReports(['u-1'], { userId: 'u-1' }, { limit: 1 });
    mockDynamo.mockClear();

    await expect(
      listMySupportedUserReports(
        ['u-1'],
        { userId: 'u-2' },
        { limit: 1, nextToken: first.nextToken as string },
      ),
    ).rejects.toThrow(/filters/);
    expect(mockDynamo).not.toHaveBeenCalled();
  });

  it('validates malformed cursors and page limits', async () => {
    await expect(
      listMySupportedUserReports(['u-1'], {}, { nextToken: 'not-json' }),
    ).rejects.toThrow('invalid nextToken');
    await expect(listMySupportedUserReports(['u-1'], {}, { limit: 101 })).rejects.toThrow('limit');
    expect(mockDynamo).not.toHaveBeenCalled();
  });

  it('does not query DynamoDB when there are no accessible users', async () => {
    await expect(listMySupportedUserReports([], {}, {})).resolves.toEqual({
      items: [],
      nextToken: null,
    });
    expect(mockDynamo).not.toHaveBeenCalled();
  });
});

describe('deleteReport', () => {
  const reportRow = {
    reportId: 'r-1',
    scope: { userId: 'u1' },
    createdAt: '2026-06-30T12:00:00.000Z',
    s3Key: 'reports/u1/r-1.json',
  };
  const journal = {
    PK: 'USER#u1',
    SK: 'REPORT_DELETION#r-1',
    userId: 'u1',
    reportId: 'r-1',
    reportCreatedAt: '2026-06-30T12:00:00.000Z',
    reportRowSk: 'REPORT#2026-06-30T12:00:00.000Z#r-1',
    jsonKey: 'reports/u1/r-1.json',
    pdfKey: 'report-pdf-cache/u1/r-1.pdf',
    createdAt: '2026-07-22T12:00:00.000Z',
  };

  it('journals before removing the report row and clears the journal after S3 cleanup', async () => {
    mockDynamo
      .mockResolvedValueOnce({ Items: [reportRow] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mockS3.mockResolvedValue({});

    const out = await deleteReport('u1', 'r-1');
    expect(out).toBe(true);
    expect(mockDynamo.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(mockDynamo.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'QueryCommand',
      'PutCommand',
      'DeleteCommand',
      'DeleteCommand',
    ]);
    expect(mockDynamo.mock.calls[1][0].input.Item).toMatchObject({
      ...journal,
      createdAt: expect.any(String),
    });
    expect(mockDynamo.mock.calls[2][0].input.Key).toEqual({
      PK: 'USER#u1',
      SK: 'REPORT#2026-06-30T12:00:00.000Z#r-1',
    });
    expect(mockDynamo.mock.calls[3][0].input.Key).toEqual({
      PK: 'USER#u1',
      SK: 'REPORT_DELETION#r-1',
    });
    expect(mockS3).toHaveBeenCalledTimes(2);
    expect(mockS3.mock.calls.map((call) => call[0].input.Key)).toEqual([
      'reports/u1/r-1.json',
      'report-pdf-cache/u1/r-1.pdf',
    ]);
    expect(mockDynamo.mock.invocationCallOrder[2]).toBeLessThan(mockS3.mock.invocationCallOrder[0]);
    expect(mockS3.mock.invocationCallOrder[1]).toBeLessThan(mockDynamo.mock.invocationCallOrder[3]);
  });

  it('resumes cleanup from the journal after an S3 failure removed the report row', async () => {
    mockDynamo
      .mockResolvedValueOnce({ Items: [reportRow] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: journal })
      .mockResolvedValueOnce({});
    mockS3
      .mockRejectedValueOnce(new Error('temporary S3 failure'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(deleteReport('u1', 'r-1')).rejects.toThrow('temporary S3 failure');
    expect(mockDynamo).toHaveBeenCalledTimes(3);

    await expect(deleteReport('u1', 'r-1')).resolves.toBe(true);
    expect(mockDynamo.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'QueryCommand',
      'PutCommand',
      'DeleteCommand',
      'QueryCommand',
      'GetCommand',
      'DeleteCommand',
    ]);
    expect(mockDynamo.mock.calls[4][0].input).toMatchObject({
      Key: { PK: 'USER#u1', SK: 'REPORT_DELETION#r-1' },
      ConsistentRead: true,
    });
    expect(mockDynamo.mock.calls[5][0].input.Key).toEqual({
      PK: 'USER#u1',
      SK: 'REPORT_DELETION#r-1',
    });
    expect(mockS3.mock.calls.map((call) => call[0].input.Key)).toEqual([
      'reports/u1/r-1.json',
      'report-pdf-cache/u1/r-1.pdf',
      'reports/u1/r-1.json',
      'report-pdf-cache/u1/r-1.pdf',
    ]);
  });

  it('throws NotFound when the report does not exist', async () => {
    mockDynamo.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    await expect(deleteReport('u1', 'missing')).rejects.toThrow('not found');
    expect(mockDynamo.mock.calls.map((call) => call[0].constructor.name)).toEqual([
      'QueryCommand',
      'GetCommand',
    ]);
    expect(mockS3).not.toHaveBeenCalled();
  });

  it('fails closed instead of deleting a key from a corrupt retry journal', async () => {
    mockDynamo
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: { ...journal, jsonKey: 'attacker-controlled-key' } });

    await expect(deleteReport('u1', 'r-1')).rejects.toThrow('deletion journal');
    expect(mockS3).not.toHaveBeenCalled();
  });
});
