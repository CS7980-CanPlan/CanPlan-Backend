import { DateTime } from 'luxon';
import { queryAll, queryAllItems } from './batch';
import { TABLE_NAME } from './dynamodb';
import {
  ENTITY,
  CATEGORY_PREFIX,
  TASK_INSTANCE_PREFIX,
  TASK_INSTANCE_STEP_PREFIX,
  TASK_OWNER_INDEX,
  userPk,
} from './keys';
import type {
  TaskInstance,
  Task,
  Category,
  ReportStats,
  TaskInstanceStep,
  ReportComputeInput,
} from './types';

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

export function aggregateByTask(instances: TaskInstance[], tasks: Task[]): ReportStats['byTask'] {
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

/** Group step snapshots by their instanceId, sorted by `order`. */
function stepsByInstance(steps: TaskInstanceStep[]): Map<string, TaskInstanceStep[]> {
  const map = new Map<string, TaskInstanceStep[]>();
  for (const s of steps) {
    const list = map.get(s.instanceId) ?? [];
    list.push(s);
    map.set(s.instanceId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.order - b.order);
  return map;
}

export function aggregateStepDwell(
  instances: TaskInstance[],
  steps: TaskInstanceStep[],
  tasks: Task[],
): ReportStats['stepDwell'] {
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  const byInstance = stepsByInstance(steps);
  const instById = new Map(instances.map((i) => [i.instanceId, i]));
  // key = `${taskId}#${order}` → accumulated seconds + sample count + step text
  const acc = new Map<
    string,
    { taskId: string; stepOrder: number; stepText: string; totalSeconds: number; samples: number }
  >();

  for (const [instanceId, instSteps] of byInstance.entries()) {
    const inst = instById.get(instanceId);
    if (!inst) continue;
    let prev = inst.startedAt; // first step is measured from instance start
    for (const s of instSteps) {
      if (s.completedAt && prev) {
        const seconds = (Date.parse(s.completedAt) - Date.parse(prev)) / 1000;
        if (seconds >= 0) {
          const key = `${s.taskId}#${s.order}`;
          const a = acc.get(key) ?? {
            taskId: s.taskId,
            stepOrder: s.order,
            stepText: s.text,
            totalSeconds: 0,
            samples: 0,
          };
          a.totalSeconds += seconds;
          a.samples++;
          acc.set(key, a);
        }
      }
      // Advance the cursor only when this step has a timestamp and is not out-of-order.
      if (s.completedAt && (!prev || s.completedAt >= prev)) prev = s.completedAt;
    }
  }

  return [...acc.values()]
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.stepOrder - b.stepOrder)
    .map((a) => ({
      taskId: a.taskId,
      title: titleOf.get(a.taskId) ?? a.taskId,
      stepOrder: a.stepOrder,
      stepText: a.stepText,
      samples: a.samples,
      avgSeconds: Math.round(a.totalSeconds / a.samples),
    }));
}

export function aggregateAbandonment(
  instances: TaskInstance[],
  steps: TaskInstanceStep[],
  tasks: Task[],
): ReportStats['abandonment'] {
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  const byInstance = stepsByInstance(steps);
  const out: ReportStats['abandonment'] = [];
  for (const inst of instances) {
    const abandoned =
      !!inst.startedAt && inst.status !== 'COMPLETED' && inst.status !== 'CANCELLED';
    if (!abandoned) continue;
    const instSteps = byInstance.get(inst.instanceId) ?? [];
    const firstIncomplete = instSteps.find((s) => !s.completed);
    out.push({
      instanceId: inst.instanceId,
      taskId: inst.taskId,
      title: titleOf.get(inst.taskId) ?? inst.taskId,
      stalledAtStepOrder: firstIncomplete ? firstIncomplete.order : null,
    });
  }
  return out;
}

export function aggregateSkipPatterns(
  instances: TaskInstance[],
  tasks: Task[],
): ReportStats['skipPatterns'] {
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  const byTaskAcc = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  for (const inst of instances) {
    if (inst.status !== 'SKIPPED') continue;
    byTaskAcc.set(inst.taskId, (byTaskAcc.get(inst.taskId) ?? 0) + 1);
    if (inst.skippedAt) {
      const hour = DateTime.fromISO(inst.skippedAt, { zone: inst.timezone }).hour;
      if (hour >= 0 && hour < 24) byHour[hour]++;
    }
  }
  return {
    byTask: [...byTaskAcc.entries()].map(([taskId, skipped]) => ({
      taskId,
      title: titleOf.get(taskId) ?? taskId,
      skipped,
    })),
    byHour,
  };
}

export function aggregateTimeOfDay(instances: TaskInstance[]): ReportStats['timeOfDay'] {
  const byHour = new Array<number>(24).fill(0);
  for (const inst of instances) {
    if (inst.status !== 'COMPLETED' || !inst.completedAt) continue;
    const hour = DateTime.fromISO(inst.completedAt, { zone: inst.timezone }).hour;
    if (hour >= 0 && hour < 24) byHour[hour]++;
  }
  return byHour;
}

export function computeReportStats(input: ReportComputeInput): ReportStats {
  const { userId, from, to, now, instances, steps, tasks, categories } = input;
  return {
    meta: {
      userId,
      from,
      to,
      basis: 'attempted-instances-only',
      totalInstances: instances.length,
    },
    completion: aggregateCompletion(instances, now),
    trend: aggregateTrend(instances),
    byCategory: aggregateByCategory(instances, tasks, categories),
    byTask: aggregateByTask(instances, tasks),
    stepDwell: aggregateStepDwell(instances, steps, tasks),
    skipPatterns: aggregateSkipPatterns(instances, tasks),
    abandonment: aggregateAbandonment(instances, steps, tasks),
    timeOfDay: aggregateTimeOfDay(instances),
  };
}

/**
 * Gather a user's task data for the range and compute the deterministic stats.
 * Instances use a single BETWEEN on the date-sorted SK; steps/categories are prefix
 * scans of the user partition; tasks come from the owner index (title + category).
 */
export async function buildReportStats(
  userId: string,
  from: string,
  to: string,
): Promise<ReportStats> {
  const pk = userPk(userId);
  const [instances, allSteps, tasks, categories] = await Promise.all([
    queryAll<TaskInstance>({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':from': `${TASK_INSTANCE_PREFIX}${from}`,
        // ￿ sorts after every `TASK_INSTANCE#<to>#...` so the whole `to` day is included.
        ':to': `${TASK_INSTANCE_PREFIX}${to}￿`,
      },
    }),
    // v1 scale limit: step rows aren't date-keyed, so this reads ALL of the user's step
    // rows and filters to the range in memory. Fine at current scale; the first scale
    // follow-up is to date-key steps (or add a GSI).
    queryAllItems<TaskInstanceStep>(pk, TASK_INSTANCE_STEP_PREFIX),
    queryAll<Task>({
      TableName: TABLE_NAME,
      IndexName: TASK_OWNER_INDEX,
      KeyConditionExpression: 'ownerId = :owner',
      FilterExpression: 'entityType = :task',
      ExpressionAttributeValues: { ':owner': userId, ':task': ENTITY.TASK },
    }),
    queryAllItems<Category>(pk, CATEGORY_PREFIX),
  ]);

  // Keep only step rows belonging to in-range instances (steps aren't date-keyed).
  const inRange = new Set(instances.map((i) => i.instanceId));
  const steps = allSteps.filter((s) => inRange.has(s.instanceId));

  return computeReportStats({
    userId,
    from,
    to,
    now: new Date().toISOString(),
    instances,
    steps,
    tasks,
    categories,
  });
}
