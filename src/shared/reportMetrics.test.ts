import {
  aggregateCompletion,
  aggregateByTask,
  aggregateByCategory,
  aggregateTrend,
  aggregateStepDwell,
  aggregateAbandonment,
  aggregateSkipPatterns,
  aggregateTimeOfDay,
  computeReportStats,
  buildReportStats,
} from './reportMetrics';
import type { TaskInstance, Task, Category, TaskInstanceStep, ReportComputeInput } from './types';
import { queryAll, queryAllItems } from './batch';

jest.mock('./batch', () => ({ queryAll: jest.fn(), queryAllItems: jest.fn() }));

const mockQueryAll = queryAll as jest.Mock;
const mockQueryAllItems = queryAllItems as jest.Mock;

const NOW = '2026-06-30T00:00:00.000Z';

function inst(p: Partial<TaskInstance>): TaskInstance {
  return {
    instanceId: 'a#2026-06-01#09:00',
    assignmentId: 'a',
    taskId: 't1',
    userId: 'u1',
    scheduledDate: '2026-06-01',
    scheduledTime: '09:00',
    scheduledFor: '2026-06-01T09:00:00.000Z',
    timezone: 'America/Toronto',
    status: 'COMPLETED',
    createdAt: NOW,
    ...p,
  };
}

describe('aggregateCompletion', () => {
  it('counts statuses, derives OVERDUE, and computes completionRate', () => {
    const out = aggregateCompletion(
      [
        inst({ status: 'COMPLETED' }),
        inst({ status: 'SKIPPED' }),
        inst({ status: 'CANCELLED' }),
        // non-terminal + past scheduledFor → OVERDUE
        inst({ status: 'TO_DO', scheduledFor: '2026-06-01T09:00:00.000Z' }),
        // non-terminal + future scheduledFor → stays TO_DO
        inst({ status: 'TO_DO', scheduledFor: '2026-12-01T09:00:00.000Z' }),
      ],
      NOW,
    );
    expect(out).toEqual({
      completed: 1,
      skipped: 1,
      cancelled: 1,
      overdue: 1,
      inProgress: 0,
      toDo: 1,
      completionRate: 0.2,
    });
  });

  it('returns a zeroed shape (completionRate 0) for no instances', () => {
    expect(aggregateCompletion([], NOW).completionRate).toBe(0);
  });
});

describe('aggregateByTask', () => {
  it('groups completion by taskId with the task title', () => {
    const tasks = [{ taskId: 't1', title: 'Brush teeth' } as Task];
    const out = aggregateByTask(
      [inst({ taskId: 't1', status: 'COMPLETED' }), inst({ taskId: 't1', status: 'SKIPPED' })],
      tasks,
    );
    expect(out).toEqual([
      { taskId: 't1', title: 'Brush teeth', completed: 1, total: 2, completionRate: 0.5 },
    ]);
  });

  it('falls back to the taskId when the task row is missing', () => {
    const out = aggregateByTask([inst({ taskId: 'gone' })], []);
    expect(out[0].title).toBe('gone');
  });
});

describe('aggregateByCategory', () => {
  it('maps task → category and groups completion by category', () => {
    const tasks = [{ taskId: 't1', categoryId: 'c1', title: 'X' } as Task];
    const cats = [{ categoryId: 'c1', name: 'Hygiene' } as Category];
    const out = aggregateByCategory([inst({ taskId: 't1', status: 'COMPLETED' })], tasks, cats);
    expect(out).toEqual([
      { categoryId: 'c1', categoryName: 'Hygiene', completed: 1, total: 1, completionRate: 1 },
    ]);
  });
});

describe('aggregateTrend', () => {
  it('buckets instances by ISO week start and computes per-week completion', () => {
    const out = aggregateTrend([
      inst({ scheduledDate: '2026-06-01', status: 'COMPLETED' }), // Mon, week of 06-01
      inst({ scheduledDate: '2026-06-03', status: 'SKIPPED' }), // same week
      inst({ scheduledDate: '2026-06-08', status: 'COMPLETED' }), // next week
    ]);
    expect(out).toEqual([
      { weekStart: '2026-06-01', completed: 1, total: 2, completionRate: 0.5 },
      { weekStart: '2026-06-08', completed: 1, total: 1, completionRate: 1 },
    ]);
  });
});

function step(p: Partial<TaskInstanceStep>): TaskInstanceStep {
  return {
    instanceId: 'a#2026-06-01#09:00',
    assignmentId: 'a',
    taskId: 't1',
    stepId: 's1',
    order: 0,
    text: 'Step',
    completed: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...p,
  };
}

describe('aggregateStepDwell', () => {
  it('derives per-step seconds (first step from startedAt, later from prev completedAt)', () => {
    const instances = [
      inst({
        instanceId: 'i1',
        taskId: 't1',
        startedAt: '2026-06-01T09:00:00.000Z',
      }),
    ];
    const steps = [
      step({ instanceId: 'i1', stepId: 's1', order: 0, text: 'A', completedAt: '2026-06-01T09:00:30.000Z' }),
      step({ instanceId: 'i1', stepId: 's2', order: 1, text: 'B', completedAt: '2026-06-01T09:01:30.000Z' }),
    ];
    const tasks = [{ taskId: 't1', title: 'Brush' } as Task];
    expect(aggregateStepDwell(instances, steps, tasks)).toEqual([
      { taskId: 't1', title: 'Brush', stepOrder: 0, stepText: 'A', samples: 1, avgSeconds: 30 },
      { taskId: 't1', title: 'Brush', stepOrder: 1, stepText: 'B', samples: 1, avgSeconds: 60 },
    ]);
  });

  it('skips steps with missing/negative gaps', () => {
    const instances = [inst({ instanceId: 'i1' })]; // no startedAt
    const steps = [step({ instanceId: 'i1', order: 0, completedAt: '2026-06-01T09:00:30.000Z' })];
    expect(aggregateStepDwell(instances, steps, [])).toEqual([]);
  });
});

describe('aggregateAbandonment', () => {
  it('flags started-but-not-completed instances and the first incomplete step', () => {
    const instances = [
      inst({ instanceId: 'i1', taskId: 't1', status: 'IN_PROGRESS', startedAt: NOW }),
    ];
    const steps = [
      step({ instanceId: 'i1', order: 0, completed: true }),
      step({ instanceId: 'i1', order: 1, completed: false }),
    ];
    const tasks = [{ taskId: 't1', title: 'Brush' } as Task];
    expect(aggregateAbandonment(instances, steps, tasks)).toEqual([
      { instanceId: 'i1', taskId: 't1', title: 'Brush', stalledAtStepOrder: 1 },
    ]);
  });

  it('ignores completed and cancelled instances', () => {
    const instances = [
      inst({ instanceId: 'i1', status: 'COMPLETED', startedAt: NOW }),
      inst({ instanceId: 'i2', status: 'CANCELLED', startedAt: NOW }),
    ];
    expect(aggregateAbandonment(instances, [], [])).toEqual([]);
  });
});

describe('aggregateSkipPatterns', () => {
  it('counts skips per task and by local hour of skippedAt', () => {
    const instances = [
      inst({
        taskId: 't1',
        status: 'SKIPPED',
        skippedAt: '2026-06-01T13:00:00.000Z', // 09:00 in America/Toronto (EDT -4)
        timezone: 'America/Toronto',
      }),
    ];
    const tasks = [{ taskId: 't1', title: 'Brush' } as Task];
    const out = aggregateSkipPatterns(instances, tasks);
    expect(out.byTask).toEqual([{ taskId: 't1', title: 'Brush', skipped: 1 }]);
    expect(out.byHour[9]).toBe(1);
    expect(out.byHour).toHaveLength(24);
  });
});

describe('aggregateTimeOfDay', () => {
  it('buckets COMPLETED instances by local completion hour', () => {
    const out = aggregateTimeOfDay([
      inst({ status: 'COMPLETED', completedAt: '2026-06-01T13:00:00.000Z', timezone: 'America/Toronto' }),
    ]);
    expect(out[9]).toBe(1);
    expect(out).toHaveLength(24);
  });
});

describe('computeReportStats', () => {
  it('assembles meta + all metric sections', () => {
    const input: ReportComputeInput = {
      userId: 'u1',
      from: '2026-06-01',
      to: '2026-06-30',
      now: NOW,
      instances: [inst({ status: 'COMPLETED' }), inst({ status: 'SKIPPED' })],
      steps: [],
      tasks: [{ taskId: 't1', title: 'Brush', categoryId: 'c1' } as Task],
      categories: [{ categoryId: 'c1', name: 'Hygiene' } as Category],
    };
    const stats = computeReportStats(input);
    expect(stats.meta).toEqual({
      userId: 'u1',
      from: '2026-06-01',
      to: '2026-06-30',
      basis: 'attempted-instances-only',
      totalInstances: 2,
    });
    expect(stats.completion.completed).toBe(1);
    expect(stats.byTask).toHaveLength(1);
    expect(stats.byCategory).toHaveLength(1);
    expect(stats.timeOfDay).toHaveLength(24);
  });

  it('produces a valid zeroed report for an empty range', () => {
    const stats = computeReportStats({
      userId: 'u1',
      from: '2026-06-01',
      to: '2026-06-30',
      now: NOW,
      instances: [],
      steps: [],
      tasks: [],
      categories: [],
    });
    expect(stats.meta.totalInstances).toBe(0);
    expect(stats.completion.completionRate).toBe(0);
    expect(stats.trend).toEqual([]);
  });
});

describe('buildReportStats', () => {
  afterEach(() => jest.clearAllMocks());

  it('queries instances by date range, steps + categories by prefix, tasks by owner index', async () => {
    mockQueryAll
      .mockResolvedValueOnce([inst({ status: 'COMPLETED' })]) // instances (BETWEEN)
      .mockResolvedValueOnce([{ taskId: 't1', title: 'Brush', categoryId: 'c1' }]); // tasks (owner index)
    mockQueryAllItems
      .mockResolvedValueOnce([]) // steps
      .mockResolvedValueOnce([{ categoryId: 'c1', name: 'Hygiene' }]); // categories

    const stats = await buildReportStats('u1', '2026-06-01', '2026-06-30');

    expect(stats.meta.totalInstances).toBe(1);
    // instances query uses a BETWEEN on the TASK_INSTANCE# prefix
    const between = mockQueryAll.mock.calls[0][0];
    expect(between.KeyConditionExpression).toContain('BETWEEN');
    expect(between.ExpressionAttributeValues[':from']).toBe('TASK_INSTANCE#2026-06-01');
    expect(between.ExpressionAttributeValues[':to']).toBe('TASK_INSTANCE#2026-06-30￿');
  });
});
