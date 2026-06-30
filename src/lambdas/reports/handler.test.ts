import { handler } from './handler';
import { assertCanAccessUserReports } from '../../shared/reportAuthz';
import { buildReportStats } from '../../shared/reportMetrics';
import { generateReportNarrative } from '../../shared/reportNarrative';
import { writeReport, listReports, getReportDownloadUrl } from '../../shared/reportStorage';

jest.mock('../../shared/reportAuthz', () => ({ assertCanAccessUserReports: jest.fn() }));
jest.mock('../../shared/reportMetrics', () => ({ buildReportStats: jest.fn() }));
jest.mock('../../shared/reportNarrative', () => ({ generateReportNarrative: jest.fn() }));
jest.mock('../../shared/reportStorage', () => ({
  writeReport: jest.fn(),
  listReports: jest.fn(),
  getReportDownloadUrl: jest.fn(),
}));

const mockAuthz = assertCanAccessUserReports as jest.Mock;
const mockStats = buildReportStats as jest.Mock;
const mockNarrative = generateReportNarrative as jest.Mock;
const mockWrite = writeReport as jest.Mock;
const mockList = listReports as jest.Mock;
const mockDownload = getReportDownloadUrl as jest.Mock;

function event(fieldName: string, args: Record<string, unknown>, sub: string | null = 'sup-1') {
  return {
    arguments: args,
    identity: sub ? { sub } : undefined,
    info: { fieldName },
  } as unknown as Parameters<typeof handler>[0];
}

beforeEach(() => {
  mockAuthz.mockResolvedValue(undefined);
  mockStats.mockResolvedValue({ meta: { totalInstances: 0 } });
  mockNarrative.mockResolvedValue('A summary.');
  mockWrite.mockImplementation(async (doc) => ({ reportId: doc.reportId, s3Key: 'k' }));
});
afterEach(() => jest.clearAllMocks());

describe('generateReport', () => {
  const input = { userId: 'u1', from: '2026-06-01', to: '2026-06-30' };

  it('authorizes, builds stats, generates narrative, persists, and returns the report', async () => {
    const result = await handler(event('generateReport', { input }));
    expect(mockAuthz).toHaveBeenCalledWith('sup-1', 'u1');
    expect(mockStats).toHaveBeenCalledWith('u1', '2026-06-01', '2026-06-30');
    expect(mockNarrative).toHaveBeenCalled();
    const doc = mockWrite.mock.calls[0][0];
    expect(doc.createdBy).toBe('sup-1');
    expect(doc.narrative).toBe('A summary.');
    expect((result as { reportId: string }).reportId).toBe(doc.reportId);
  });

  it('rejects an unauthenticated caller before doing any work', async () => {
    await expect(handler(event('generateReport', { input }, null))).rejects.toThrow('Unauthorized');
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('rejects from > to', async () => {
    await expect(
      handler(event('generateReport', { input: { userId: 'u1', from: '2026-06-30', to: '2026-06-01' } })),
    ).rejects.toThrow('from');
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('does not persist when narrative generation fails', async () => {
    mockNarrative.mockRejectedValue(new Error('bedrock down'));
    await expect(handler(event('generateReport', { input }))).rejects.toThrow('bedrock down');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('still produces a report for an empty range (zero instances)', async () => {
    await handler(event('generateReport', { input }));
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
});

describe('listReports', () => {
  it('authorizes then lists', async () => {
    mockList.mockResolvedValue({ items: [], nextToken: null });
    await handler(event('listReports', { userId: 'u1' }));
    expect(mockAuthz).toHaveBeenCalledWith('sup-1', 'u1');
    expect(mockList).toHaveBeenCalledWith('u1', { limit: undefined, nextToken: undefined });
  });
});

describe('getReportDownloadUrl', () => {
  it('authorizes then signs', async () => {
    mockDownload.mockResolvedValue({ downloadUrl: 'x', s3Key: 'k', expiresIn: 900 });
    await handler(event('getReportDownloadUrl', { userId: 'u1', reportId: 'r-1' }));
    expect(mockAuthz).toHaveBeenCalledWith('sup-1', 'u1');
    expect(mockDownload).toHaveBeenCalledWith('u1', 'r-1');
  });
});
