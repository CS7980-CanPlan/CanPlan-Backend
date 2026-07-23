import {
  aggregateCompletion,
  aggregateByTask,
  aggregateByCategory,
  aggregateTrend,
  aggregateStepDwell,
  aggregateFocus,
  aggregateAbandonment,
  aggregateSkipPatterns,
  aggregateTimeOfDay,
  computeReportStats,
  buildReportStats,
} from './reportMetrics';
import type { TaskInstance, Task, Category, TaskInstanceStep, ReportComputeInput } from './types';
import { batchGet, queryAll, queryAllItems } from './batch';

jest.mock('./batch', () => ({
  batchGet: jest.fn(),
  queryAll: jest.fn(),
  queryAllItems: jest.fn(),
}));

const mockBatchGet = batchGet as jest.Mock;
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
    activeDurationSeconds: 0,
    createdAt: NOW,
    ...p,
  };
}

/** A pre-timing row read raw from DynamoDB: the *DurationSeconds attributes don't exist. */
function legacy<T extends TaskInstance | TaskInstanceStep>(row: T): T {
  const r = row as unknown as Record<string, unknown>;
  delete r.activeDurationSeconds;
  delete r.elapsedSeconds;
  return row;
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
    const tasks = [{ taskId: 't1', ownerId: 'support-1', categoryId: 'c1', title: 'X' } as Task];
    const cats = [{ categoryId: 'c1', ownerId: 'support-1', name: 'Hygiene' } as Category];
    const out = aggregateByCategory([inst({ taskId: 't1', status: 'COMPLETED' })], tasks, cats);
    expect(out).toEqual([
      { categoryId: 'c1', categoryName: 'Hygiene', completed: 1, total: 1, completionRate: 1 },
    ]);
  });

  it('keeps an owner/category pair isolated if category ids ever collide across owners', () => {
    const tasks = [
      { taskId: 't1', ownerId: 'support-1', categoryId: 'same-id', title: 'X' } as Task,
      { taskId: 't2', ownerId: 'support-2', categoryId: 'same-id', title: 'Y' } as Task,
    ];
    const cats = [
      { categoryId: 'same-id', ownerId: 'support-1', name: 'Morning' } as Category,
      { categoryId: 'same-id', ownerId: 'support-2', name: 'Evening' } as Category,
    ];

    expect(
      aggregateByCategory(
        [inst({ taskId: 't1', status: 'COMPLETED' }), inst({ taskId: 't2', status: 'SKIPPED' })],
        tasks,
        cats,
      ),
    ).toEqual([
      {
        categoryId: 'same-id',
        categoryName: 'Morning',
        completed: 1,
        total: 1,
        completionRate: 1,
      },
      {
        categoryId: 'same-id',
        categoryName: 'Evening',
        completed: 0,
        total: 1,
        completionRate: 0,
      },
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
    activeDurationSeconds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...p,
  };
}

const STARTED = '2026-06-01T09:00:00.000Z';

describe('aggregateStepDwell', () => {
  it('averages server-measured active seconds per (task, step order) across instances', () => {
    const steps = [
      step({
        instanceId: 'i1',
        stepId: 's1',
        order: 0,
        text: 'A',
        firstStartedAt: STARTED,
        activeDurationSeconds: 30,
      }),
      step({
        instanceId: 'i2',
        stepId: 's1',
        order: 0,
        text: 'A',
        firstStartedAt: STARTED,
        activeDurationSeconds: 90,
      }),
      step({
        instanceId: 'i1',
        stepId: 's2',
        order: 1,
        text: 'B',
        firstStartedAt: STARTED,
        activeDurationSeconds: 60,
      }),
    ];
    const tasks = [{ taskId: 't1', title: 'Brush' } as Task];
    expect(aggregateStepDwell(steps, tasks)).toEqual([
      { taskId: 't1', title: 'Brush', stepOrder: 0, stepText: 'A', samples: 2, avgSeconds: 60 },
      { taskId: 't1', title: 'Brush', stepOrder: 1, stepText: 'B', samples: 1, avgSeconds: 60 },
    ]);
  });

  it('counts started-but-never-completed steps (effort on abandoned steps is signal)', () => {
    const steps = [
      step({ order: 0, completed: false, firstStartedAt: STARTED, activeDurationSeconds: 120 }),
    ];
    expect(aggregateStepDwell(steps, [])).toEqual([
      { taskId: 't1', title: 't1', stepOrder: 0, stepText: 'Step', samples: 1, avgSeconds: 120 },
    ]);
  });

  it('excludes never-started steps and legacy snapshots without timing', () => {
    const steps = [
      step({ order: 0 }), // timing era, but the step was never started
      legacy(step({ order: 1, completedAt: '2026-06-01T09:00:30.000Z' })), // pre-timing row
    ];
    expect(aggregateStepDwell(steps, [])).toEqual([]);
  });
});

describe('aggregateFocus', () => {
  it('averages per-task active seconds and computes the overall focus ratio', () => {
    const instances = [
      inst({
        instanceId: 'i1',
        taskId: 't1',
        status: 'COMPLETED',
        activeDurationSeconds: 300,
        elapsedSeconds: 600,
      }),
      inst({ instanceId: 'i2', taskId: 't1', status: 'IN_PROGRESS', activeDurationSeconds: 100 }),
    ];
    const tasks = [{ taskId: 't1', title: 'Brush' } as Task];
    expect(aggregateFocus(instances, tasks)).toEqual({
      byTask: [{ taskId: 't1', title: 'Brush', samples: 2, avgActiveSeconds: 200 }],
      focusRatio: 0.5, // only i1 qualifies (COMPLETED with elapsedSeconds)
    });
  });

  it('excludes legacy instances and returns a null ratio when nothing qualifies', () => {
    const instances = [legacy(inst({ status: 'COMPLETED' }))];
    expect(aggregateFocus(instances, [])).toEqual({ byTask: [], focusRatio: null });
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
      inst({
        status: 'COMPLETED',
        completedAt: '2026-06-01T13:00:00.000Z',
        timezone: 'America/Toronto',
      }),
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
    expect(stats.focus.byTask).toHaveLength(1);
    expect(stats.focus.focusRatio).toBeNull(); // no COMPLETED instance carries elapsedSeconds
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
    expect(stats.focus).toEqual({ byTask: [], focusRatio: null });
  });
});

describe('buildReportStats', () => {
  afterEach(() => jest.resetAllMocks());

  it('loads metadata from the SupportPerson-owned task assigned to the primary user', async () => {
    mockQueryAll.mockResolvedValueOnce([
      inst({ instanceId: 'i1', taskId: 'support-task', status: 'COMPLETED' }),
      inst({ instanceId: 'i2', taskId: 'support-task', status: 'SKIPPED' }),
    ]);
    mockQueryAllItems.mockResolvedValueOnce([]);
    mockBatchGet
      .mockResolvedValueOnce([
        {
          PK: 'TASK#support-task',
          SK: '#META',
          entityType: 'Task',
          taskId: 'support-task',
          ownerId: 'support-1',
          title: 'Supported morning routine',
          categoryId: 'support-category',
        },
      ])
      .mockResolvedValueOnce([
        {
          PK: 'USER#support-1',
          SK: 'CATEGORY#support-category',
          entityType: 'Category',
          categoryId: 'support-category',
          ownerId: 'support-1',
          name: 'Daily living',
        },
      ]);

    const stats = await buildReportStats('u1', '2026-06-01', '2026-06-30');

    expect(stats.meta.totalInstances).toBe(2);
    expect(stats.byTask).toEqual([
      {
        taskId: 'support-task',
        title: 'Supported morning routine',
        completed: 1,
        total: 2,
        completionRate: 0.5,
      },
    ]);
    expect(stats.byCategory).toEqual([
      {
        categoryId: 'support-category',
        categoryName: 'Daily living',
        completed: 1,
        total: 2,
        completionRate: 0.5,
      },
    ]);

    // instances query uses a BETWEEN on the TASK_INSTANCE# prefix
    const between = mockQueryAll.mock.calls[0][0];
    expect(between.KeyConditionExpression).toContain('BETWEEN');
    expect(between.ExpressionAttributeValues[':from']).toBe('TASK_INSTANCE#2026-06-01');
    expect(between.ExpressionAttributeValues[':to']).toBe('TASK_INSTANCE#2026-06-30￿');

    // Duplicate occurrences load one task row, then only that task owner's category.
    expect(mockBatchGet.mock.calls[0][0]).toEqual([{ PK: 'TASK#support-task', SK: '#META' }]);
    expect(mockBatchGet.mock.calls[1][0]).toEqual([
      { PK: 'USER#support-1', SK: 'CATEGORY#support-category' },
    ]);
  });

  it('preserves counts and safe fallbacks when a referenced task or category was deleted', async () => {
    mockQueryAll.mockResolvedValueOnce([
      inst({ instanceId: 'i1', taskId: 'known-task', status: 'COMPLETED' }),
      inst({ instanceId: 'i2', taskId: 'deleted-task', status: 'SKIPPED' }),
    ]);
    mockQueryAllItems.mockResolvedValueOnce([]);
    mockBatchGet
      .mockResolvedValueOnce([
        {
          PK: 'TASK#known-task',
          SK: '#META',
          entityType: 'Task',
          taskId: 'known-task',
          ownerId: 'support-1',
          title: 'Known task',
          categoryId: 'deleted-category',
        },
        // DynamoDB omits the missing TASK#deleted-task row.
      ])
      .mockResolvedValueOnce([]); // referenced category was also deleted

    const stats = await buildReportStats('u1', '2026-06-01', '2026-06-30');

    expect(stats.meta.totalInstances).toBe(2);
    expect(stats.completion.completed).toBe(1);
    expect(stats.completion.skipped).toBe(1);
    expect(stats.byTask).toEqual([
      {
        taskId: 'known-task',
        title: 'Known task',
        completed: 1,
        total: 1,
        completionRate: 1,
      },
      {
        taskId: 'deleted-task',
        title: 'deleted-task',
        completed: 0,
        total: 1,
        completionRate: 0,
      },
    ]);
    expect(stats.byCategory).toEqual([
      {
        categoryId: 'deleted-category',
        categoryName: 'deleted-category',
        completed: 1,
        total: 1,
        completionRate: 1,
      },
      {
        categoryId: 'unknown',
        categoryName: 'unknown',
        completed: 0,
        total: 1,
        completionRate: 0,
      },
    ]);
  });
});
