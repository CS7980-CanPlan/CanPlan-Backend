import { PDFDocument } from 'pdf-lib';
import { normalizeReportPdfText, renderReportPdf } from './reportPdf';
import type { ReportDocument, ReportStats } from './types';

const BASE_STATS: ReportStats = {
  meta: {
    userId: 'user-1',
    from: '2026-07-01',
    to: '2026-07-22',
    basis: 'attempted-instances-only',
    totalInstances: 4,
  },
  completion: {
    completed: 2,
    skipped: 1,
    cancelled: 0,
    overdue: 0,
    inProgress: 1,
    toDo: 0,
    completionRate: 0.5,
  },
  trend: [
    { weekStart: '2026-06-29', completed: 1, total: 2, completionRate: 0.5 },
    { weekStart: '2026-07-06', completed: 1, total: 2, completionRate: 0.5 },
  ],
  byCategory: [
    {
      categoryId: 'category-1',
      categoryName: 'Daily living',
      completed: 2,
      total: 4,
      completionRate: 0.5,
    },
  ],
  byTask: [
    { taskId: 'task-1', title: 'Prepare breakfast', completed: 2, total: 3, completionRate: 2 / 3 },
  ],
  stepDwell: [
    {
      taskId: 'task-1',
      title: 'Prepare breakfast',
      stepOrder: 1,
      stepText: 'Collect ingredients',
      samples: 2,
      avgSeconds: 95,
    },
  ],
  focus: {
    byTask: [{ taskId: 'task-1', title: 'Prepare breakfast', samples: 2, avgActiveSeconds: 320 }],
    focusRatio: 0.72,
  },
  skipPatterns: {
    byTask: [{ taskId: 'task-2', title: 'Take a walk', skipped: 1 }],
    byHour: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  abandonment: [
    {
      instanceId: 'assignment-1#2026-07-20#09:00',
      taskId: 'task-3',
      title: 'Tidy room',
      stalledAtStepOrder: 2,
    },
  ],
  timeOfDay: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

function report(stats: ReportStats = BASE_STATS): ReportDocument {
  return {
    reportId: 'report-1',
    scope: { userId: 'user-1' },
    dateRange: { from: '2026-07-01', to: '2026-07-22' },
    createdBy: 'support-1',
    createdAt: '2026-07-22T12:00:00.000Z',
    narrative:
      'Renée completed half of attempted tasks — a steady result. 早餐 😀 remained challenging.',
    stats,
  };
}

describe('normalizeReportPdfText', () => {
  it('transliterates common Unicode and replaces unsupported glyphs without controls', () => {
    expect(normalizeReportPdfText('Crème brûlée — “Łódź” • 早餐 😀\u202ehidden')).toBe(
      'Creme brulee - "Lodz" * ?? ?hidden',
    );
  });

  it('preserves useful line breaks and expands tabs', () => {
    expect(normalizeReportPdfText('one\r\ntwo\tthree')).toBe('one\ntwo    three');
  });
});

describe('renderReportPdf', () => {
  it('renders every report section into a valid, multi-page PDF without external I/O', async () => {
    const bytes = await renderReportPdf(report());

    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
    expect(parsed.getTitle()).toBe('CanPlan progress report');
    expect(parsed.getSubject()).toContain('user-1');
    expect(parsed.getCreationDate()?.toISOString()).toBe('2026-07-22T12:00:00.000Z');
  });

  it('handles empty metric collections and unavailable ratios', async () => {
    const stats: ReportStats = {
      ...BASE_STATS,
      trend: [],
      byCategory: [],
      byTask: [],
      stepDwell: [],
      focus: { byTask: [], focusRatio: null },
      skipPatterns: { byTask: [], byHour: new Array<number>(24).fill(0) },
      abandonment: [],
      timeOfDay: new Array<number>(24).fill(0),
    };

    const bytes = await renderReportPdf(report(stats));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it('wraps long report content across additional pages', async () => {
    const stats: ReportStats = {
      ...BASE_STATS,
      byTask: Array.from({ length: 80 }, (_, index) => ({
        taskId: `task-${index}`,
        title: `A deliberately long task title ${index} that must wrap safely in the report table`,
        completed: index % 3,
        total: 3,
        completionRate: (index % 3) / 3,
      })),
    };

    const bytes = await renderReportPdf(report(stats));
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(4);
  });
});
