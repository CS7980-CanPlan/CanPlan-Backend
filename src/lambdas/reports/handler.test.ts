// The reports handler exercises the REAL draft-token module (generate → save round-trip),
// so a signing secret must be present. Everything else (authz, stats, narrative, storage) is mocked.
process.env.REPORT_DRAFT_SIGNING_SECRET = 'handler-test-secret';

import { handler } from './handler';
import { assertCanAccessUserReports, listAccessibleReportUserIds } from '../../shared/reportAuthz';
import { buildReportStats } from '../../shared/reportMetrics';
import { generateReportNarrative } from '../../shared/reportNarrative';
import {
  writeReport,
  listReports,
  listMySupportedUserReports,
  getReportDownloadUrl,
  getReportPdfDownloadUrl,
  deleteReport,
} from '../../shared/reportStorage';
import type { GeneratedReport, Report, SaveReportInput } from '../../shared/types';

jest.mock('../../shared/reportAuthz', () => ({
  assertCanAccessUserReports: jest.fn(),
  listAccessibleReportUserIds: jest.fn(),
}));
jest.mock('../../shared/reportMetrics', () => ({ buildReportStats: jest.fn() }));
jest.mock('../../shared/reportNarrative', () => ({ generateReportNarrative: jest.fn() }));
jest.mock('../../shared/reportStorage', () => ({
  writeReport: jest.fn(),
  listReports: jest.fn(),
  listMySupportedUserReports: jest.fn(),
  getReportDownloadUrl: jest.fn(),
  getReportPdfDownloadUrl: jest.fn(),
  deleteReport: jest.fn(),
}));

const mockAuthz = assertCanAccessUserReports as jest.Mock;
const mockAccessibleUserIds = listAccessibleReportUserIds as jest.Mock;
const mockStats = buildReportStats as jest.Mock;
const mockNarrative = generateReportNarrative as jest.Mock;
const mockWrite = writeReport as jest.Mock;
const mockList = listReports as jest.Mock;
const mockListSupported = listMySupportedUserReports as jest.Mock;
const mockDownload = getReportDownloadUrl as jest.Mock;
const mockPdfDownload = getReportPdfDownloadUrl as jest.Mock;
const mockDelete = deleteReport as jest.Mock;

const STATS = { meta: { totalInstances: 2 }, completion: { completionRate: 0.5 } };

function event(fieldName: string, args: Record<string, unknown>, sub: string | null = 'sup-1') {
  return {
    arguments: args,
    identity: sub ? { sub } : undefined,
    info: { fieldName },
  } as unknown as Parameters<typeof handler>[0];
}

/** Map a GeneratedReport into the SaveReportInput a client would return, JSON-round-tripping
 * the AWSJSON fields (as they would be after serialization to/from the client). */
function toSaveInput(gen: GeneratedReport): SaveReportInput {
  return {
    draftToken: gen.draftToken,
    scope: JSON.parse(JSON.stringify(gen.scope)),
    dateRange: JSON.parse(JSON.stringify(gen.dateRange)),
    generatedAt: gen.generatedAt,
    narrative: gen.narrative,
    stats: JSON.parse(JSON.stringify(gen.stats)),
  };
}

const input = { userId: 'u1', from: '2026-06-01', to: '2026-06-30' };

/** Run generateReport and return its GeneratedReport payload. */
async function generate(): Promise<GeneratedReport> {
  return (await handler(event('generateReport', { input }))) as GeneratedReport;
}

beforeEach(() => {
  mockAuthz.mockResolvedValue('sup-1');
  mockAccessibleUserIds.mockResolvedValue(['u1', 'u2']);
  mockStats.mockResolvedValue(STATS);
  mockNarrative.mockResolvedValue('A summary.');
  mockWrite.mockImplementation(async (doc) => ({
    reportId: doc.reportId,
    scope: doc.scope,
    dateRange: doc.dateRange,
    s3Key: `reports/${doc.scope.userId}/${doc.reportId}.json`,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
  }));
});
afterEach(() => jest.clearAllMocks());

describe('generateReport', () => {
  it('authorizes, builds stats, generates a narrative, and returns a signed draft WITHOUT persisting', async () => {
    const result = await generate();
    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u1');
    expect(mockStats).toHaveBeenCalledWith('u1', '2026-06-01', '2026-06-30');
    expect(mockNarrative).toHaveBeenCalled();
    // The core split: generateReport never writes.
    expect(mockWrite).not.toHaveBeenCalled();
    expect(typeof result.draftToken).toBe('string');
    expect(result.draftToken.length).toBeGreaterThan(0);
    expect(result.narrative).toBe('A summary.');
    expect(result.stats).toEqual(STATS);
    expect(result.scope).toEqual({ userId: 'u1' });
    expect(result.dateRange).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(result.generatedAt).toEqual(expect.any(String));
  });

  it('rejects an unauthenticated caller before doing any work', async () => {
    await expect(handler(event('generateReport', { input }, null))).rejects.toThrow('Unauthorized');
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('rejects from > to', async () => {
    await expect(
      handler(
        event('generateReport', { input: { userId: 'u1', from: '2026-06-30', to: '2026-06-01' } }),
      ),
    ).rejects.toThrow('from');
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('accepts a report range of exactly 366 inclusive calendar days', async () => {
    await expect(
      handler(
        event('generateReport', {
          input: { userId: 'u1', from: '2026-01-01', to: '2027-01-01' },
        }),
      ),
    ).resolves.toMatchObject({
      scope: { userId: 'u1' },
      dateRange: { from: '2026-01-01', to: '2027-01-01' },
    });
    expect(mockStats).toHaveBeenCalledWith('u1', '2026-01-01', '2027-01-01');
  });

  it('rejects a report range of 367 inclusive calendar days', async () => {
    await expect(
      handler(
        event('generateReport', {
          input: { userId: 'u1', from: '2026-01-01', to: '2027-01-02' },
        }),
      ),
    ).rejects.toThrow('at most 366 days');
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('does not persist when narrative generation fails', async () => {
    mockNarrative.mockRejectedValue(new Error('bedrock down'));
    await expect(handler(event('generateReport', { input }))).rejects.toThrow('bedrock down');
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('saveReport', () => {
  it('verifies the draft token and persists via writeReport, echoing content inline', async () => {
    const gen = await generate();
    mockWrite.mockClear(); // ignore the (zero) generate-phase writes
    const result = (await handler(event('saveReport', { input: toSaveInput(gen) }))) as Report;

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const doc = mockWrite.mock.calls[0][0];
    expect(doc.createdBy).toBe('sup-1');
    expect(doc.scope).toEqual({ userId: 'u1' });
    expect(doc.dateRange).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(doc.narrative).toBe('A summary.');
    expect(doc.stats).toEqual(STATS);
    expect(result.narrative).toBe('A summary.');
    expect(result.stats).toEqual(STATS);
    expect(result.s3Key).toBe(`reports/u1/${doc.reportId}.json`);
  });

  it('does NOT recompute stats or call the narrative model', async () => {
    const gen = await generate();
    mockStats.mockClear();
    mockNarrative.mockClear();
    await handler(event('saveReport', { input: toSaveInput(gen) }));
    expect(mockStats).not.toHaveBeenCalled();
    expect(mockNarrative).not.toHaveBeenCalled();
  });

  it('authorizes against the userId bound in the draft token', async () => {
    const gen = await generate();
    mockAuthz.mockClear();
    await handler(event('saveReport', { input: toSaveInput(gen) }));
    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u1');
  });

  it.each([
    ['narrative', (s: SaveReportInput) => ({ ...s, narrative: 'tampered summary' })],
    ['stats', (s: SaveReportInput) => ({ ...s, stats: { meta: { totalInstances: 999 } } })],
    [
      'dateRange',
      (s: SaveReportInput) => ({ ...s, dateRange: { from: '2020-01-01', to: '2020-12-31' } }),
    ],
    ['userId', (s: SaveReportInput) => ({ ...s, scope: { userId: 'attacker' } })],
  ])('rejects a tampered %s and writes nothing', async (_field, tamper) => {
    const gen = await generate();
    mockWrite.mockClear();
    const tampered = tamper(toSaveInput(gen)) as SaveReportInput;
    await expect(handler(event('saveReport', { input: tampered }))).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('rejects an expired draft token', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-06T00:00:00.000Z'));
      const gen = await generate();
      const saveInput = toSaveInput(gen);
      // Advance past the 15-minute TTL.
      jest.setSystemTime(new Date('2026-07-06T00:16:00.000Z'));
      mockWrite.mockClear();
      await expect(handler(event('saveReport', { input: saveInput }))).rejects.toThrow(/expired/);
      expect(mockWrite).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a missing draft token before authorizing or writing', async () => {
    const gen = await generate();
    const noToken = toSaveInput(gen) as Partial<SaveReportInput>;
    delete noToken.draftToken;
    mockAuthz.mockClear();
    mockWrite.mockClear();
    await expect(
      handler(event('saveReport', { input: noToken as SaveReportInput })),
    ).rejects.toThrow('draftToken');
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockAuthz).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const gen = await generate();
    await expect(handler(event('saveReport', { input: toSaveInput(gen) }, null))).rejects.toThrow(
      'Unauthorized',
    );
  });
});

describe('deleteReport', () => {
  it('authorizes then deletes', async () => {
    mockDelete.mockResolvedValue(true);
    const result = await handler(event('deleteReport', { userId: 'u1', reportId: 'r-1' }));
    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u1');
    expect(mockDelete).toHaveBeenCalledWith('u1', 'r-1');
    expect(result).toBe(true);
  });

  it('rejects a missing reportId', async () => {
    await expect(handler(event('deleteReport', { userId: 'u1' }))).rejects.toThrow('reportId');
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('listReports', () => {
  it('authorizes then lists', async () => {
    mockList.mockResolvedValue({ items: [], nextToken: null });
    await handler(event('listReports', { userId: 'u1' }));
    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u1');
    expect(mockList).toHaveBeenCalledWith('u1', { limit: undefined, nextToken: undefined });
  });
});

describe('listMySupportedUserReports', () => {
  it('lists every currently accessible user with newest-first pagination arguments', async () => {
    mockListSupported.mockResolvedValue({ items: [], nextToken: null });
    await handler(event('listMySupportedUserReports', { limit: 25, nextToken: 'opaque-token' }));

    expect(mockAccessibleUserIds).toHaveBeenCalledWith({ sub: 'sup-1' });
    expect(mockAuthz).not.toHaveBeenCalled();
    expect(mockListSupported).toHaveBeenCalledWith(
      ['u1', 'u2'],
      { userId: undefined, createdFrom: undefined, createdTo: undefined },
      { limit: 25, nextToken: 'opaque-token' },
    );
  });

  it('authorizes a selected user directly and canonicalizes saved-at timestamps', async () => {
    mockListSupported.mockResolvedValue({ items: [], nextToken: null });
    await handler(
      event('listMySupportedUserReports', {
        filter: {
          userId: '  u2  ',
          createdFrom: '2026-07-01T00:00:00-07:00',
          createdTo: '2026-07-02T23:59:59-07:00',
        },
      }),
    );

    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u2');
    expect(mockAccessibleUserIds).not.toHaveBeenCalled();
    expect(mockListSupported).toHaveBeenCalledWith(
      ['u2'],
      {
        userId: 'u2',
        createdFrom: '2026-07-01T07:00:00.000Z',
        createdTo: '2026-07-03T06:59:59.000Z',
      },
      { limit: undefined, nextToken: undefined },
    );
  });

  it('treats explicit null filter fields as omitted', async () => {
    mockListSupported.mockResolvedValue({ items: [], nextToken: null });
    await handler(
      event('listMySupportedUserReports', {
        filter: { userId: null, createdFrom: null, createdTo: null },
      }),
    );

    expect(mockAccessibleUserIds).toHaveBeenCalledWith({ sub: 'sup-1' });
    expect(mockAuthz).not.toHaveBeenCalled();
    expect(mockListSupported).toHaveBeenCalledWith(
      ['u1', 'u2'],
      { userId: undefined, createdFrom: undefined, createdTo: undefined },
      { limit: undefined, nextToken: undefined },
    );
  });

  it.each([
    ['an invalid createdFrom', { createdFrom: 'not-a-date' }, 'filter.createdFrom'],
    [
      'an inverted date range',
      {
        createdFrom: '2026-07-03T00:00:00.000Z',
        createdTo: '2026-07-02T00:00:00.000Z',
      },
      'on or before',
    ],
    ['an empty userId', { userId: '  ' }, 'filter.userId'],
  ])('rejects %s before authorization or storage', async (_case, filter, message) => {
    await expect(handler(event('listMySupportedUserReports', { filter }))).rejects.toThrow(message);
    expect(mockAuthz).not.toHaveBeenCalled();
    expect(mockAccessibleUserIds).not.toHaveBeenCalled();
    expect(mockListSupported).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller before resolving support links', async () => {
    await expect(handler(event('listMySupportedUserReports', {}, null))).rejects.toThrow(
      'Unauthorized',
    );
    expect(mockAccessibleUserIds).not.toHaveBeenCalled();
    expect(mockListSupported).not.toHaveBeenCalled();
  });
});

describe('getReportDownloadUrl', () => {
  it('authorizes then signs', async () => {
    mockDownload.mockResolvedValue({ downloadUrl: 'x', s3Key: 'k', expiresIn: 900 });
    await handler(event('getReportDownloadUrl', { userId: 'u1', reportId: 'r-1' }));
    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u1');
    expect(mockDownload).toHaveBeenCalledWith('u1', 'r-1');
  });
});

describe('getReportPdfDownloadUrl', () => {
  it('authorizes the current support relationship before generating and signing the PDF', async () => {
    mockPdfDownload.mockResolvedValue({
      downloadUrl: 'https://pdf',
      s3Key: 'report-pdf-cache/u1/r-1.pdf',
      expiresIn: 900,
    });

    const result = await handler(
      event('getReportPdfDownloadUrl', { userId: '  u1  ', reportId: '  r-1  ' }),
    );

    expect(mockAuthz).toHaveBeenCalledWith({ sub: 'sup-1' }, 'u1');
    expect(mockPdfDownload).toHaveBeenCalledWith('u1', 'r-1');
    expect(result).toMatchObject({ downloadUrl: 'https://pdf', expiresIn: 900 });
  });

  it('rejects missing identifiers before authorization or storage work', async () => {
    await expect(
      handler(event('getReportPdfDownloadUrl', { userId: 'u1', reportId: '  ' })),
    ).rejects.toThrow('reportId');
    expect(mockAuthz).not.toHaveBeenCalled();
    expect(mockPdfDownload).not.toHaveBeenCalled();
  });
});
