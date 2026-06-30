import {
  aggregateCompletion,
  aggregateByTask,
  aggregateByCategory,
  aggregateTrend,
} from './reportMetrics';
import type { TaskInstance, Task, Category } from './types';

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
