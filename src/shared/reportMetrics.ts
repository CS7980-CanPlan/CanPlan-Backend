import { DateTime } from 'luxon';
import type { TaskInstance, Task, Category, ReportStats } from './types';

/** Round to 4 decimals so completionRate is stable for assertions and JSON. */
function rate(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((completed / total) * 10000) / 10000;
}

/** OVERDUE is derived, never stored: a non-terminal instance whose slot is in the past. */
export function isOverdue(inst: TaskInstance, now: string): boolean {
  return (inst.status === 'TO_DO' || inst.status === 'IN_PROGRESS') && inst.scheduledFor < now;
}

export function aggregateCompletion(
  instances: TaskInstance[],
  now: string,
): ReportStats['completion'] {
  let completed = 0,
    skipped = 0,
    cancelled = 0,
    overdue = 0,
    inProgress = 0,
    toDo = 0;
  for (const inst of instances) {
    if (inst.status === 'COMPLETED') completed++;
    else if (inst.status === 'SKIPPED') skipped++;
    else if (inst.status === 'CANCELLED') cancelled++;
    else if (isOverdue(inst, now)) overdue++;
    else if (inst.status === 'IN_PROGRESS') inProgress++;
    else toDo++; // TO_DO, not yet overdue
  }
  return {
    completed,
    skipped,
    cancelled,
    overdue,
    inProgress,
    toDo,
    completionRate: rate(completed, instances.length),
  };
}

export function aggregateByTask(
  instances: TaskInstance[],
  tasks: Task[],
): ReportStats['byTask'] {
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  const acc = new Map<string, { completed: number; total: number }>();
  for (const inst of instances) {
    const a = acc.get(inst.taskId) ?? { completed: 0, total: 0 };
    a.total++;
    if (inst.status === 'COMPLETED') a.completed++;
    acc.set(inst.taskId, a);
  }
  return [...acc.entries()].map(([taskId, a]) => ({
    taskId,
    title: titleOf.get(taskId) ?? taskId,
    completed: a.completed,
    total: a.total,
    completionRate: rate(a.completed, a.total),
  }));
}

export function aggregateByCategory(
  instances: TaskInstance[],
  tasks: Task[],
  categories: Category[],
): ReportStats['byCategory'] {
  const categoryOfTask = new Map(tasks.map((t) => [t.taskId, t.categoryId]));
  const nameOfCategory = new Map(categories.map((c) => [c.categoryId, c.name]));
  const acc = new Map<string, { completed: number; total: number }>();
  for (const inst of instances) {
    const categoryId = categoryOfTask.get(inst.taskId) ?? 'unknown';
    const a = acc.get(categoryId) ?? { completed: 0, total: 0 };
    a.total++;
    if (inst.status === 'COMPLETED') a.completed++;
    acc.set(categoryId, a);
  }
  return [...acc.entries()].map(([categoryId, a]) => ({
    categoryId,
    categoryName: nameOfCategory.get(categoryId) ?? categoryId,
    completed: a.completed,
    total: a.total,
    completionRate: rate(a.completed, a.total),
  }));
}

export function aggregateTrend(instances: TaskInstance[]): ReportStats['trend'] {
  const acc = new Map<string, { completed: number; total: number }>();
  for (const inst of instances) {
    // ISO week start (Monday); scheduledDate is a local YYYY-MM-DD, zone-independent.
    const weekStart =
      DateTime.fromISO(inst.scheduledDate).startOf('week').toISODate() ?? inst.scheduledDate;
    const a = acc.get(weekStart) ?? { completed: 0, total: 0 };
    a.total++;
    if (inst.status === 'COMPLETED') a.completed++;
    acc.set(weekStart, a);
  }
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, a]) => ({
      weekStart,
      completed: a.completed,
      total: a.total,
      completionRate: rate(a.completed, a.total),
    }));
}
