import { generateReportNarrative } from './reportNarrative';
import { bedrock } from './bedrock';
import type { ReportStats } from './types';

jest.mock('./bedrock', () => ({
  bedrock: { send: jest.fn() },
  BEDROCK_MODEL_ID: 'test-model',
  BEDROCK_MAX_TOKENS: 1024,
}));

const mockSend = bedrock.send as jest.Mock;

const STATS: ReportStats = {
  meta: { userId: 'u1', from: '2026-06-01', to: '2026-06-30', basis: 'attempted-instances-only', totalInstances: 2 },
  completion: { completed: 1, skipped: 1, cancelled: 0, overdue: 0, inProgress: 0, toDo: 0, completionRate: 0.5 },
  trend: [],
  byCategory: [],
  byTask: [],
  stepDwell: [],
  skipPatterns: { byTask: [], byHour: new Array(24).fill(0) },
  abandonment: [],
  timeOfDay: new Array(24).fill(0),
};

afterEach(() => jest.clearAllMocks());

describe('generateReportNarrative', () => {
  it('sends the stats to Bedrock and returns the joined text', async () => {
    mockSend.mockResolvedValue({
      output: { message: { content: [{ text: 'Half of attempted tasks were completed.' }] } },
    });
    const narrative = await generateReportNarrative(STATS);
    expect(narrative).toBe('Half of attempted tasks were completed.');
    // The prompt must carry the stats JSON, not raw instances.
    const sent = mockSend.mock.calls[0][0].input;
    expect(JSON.stringify(sent)).toContain('attempted-instances-only');
  });

  it('throws when Bedrock returns empty text', async () => {
    mockSend.mockResolvedValue({ output: { message: { content: [] } } });
    await expect(generateReportNarrative(STATS)).rejects.toThrow('narrative');
  });
});
