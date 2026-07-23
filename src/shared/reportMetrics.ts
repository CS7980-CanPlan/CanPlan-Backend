import { DateTime } from 'luxon';
import { batchGet, queryAll, queryAllItems } from './batch';
import { TABLE_NAME } from './dynamodb';
import {
  ENTITY,
  META_SK,
  TASK_INSTANCE_PREFIX,
  TASK_INSTANCE_STEP_PREFIX,
  categorySk,
  taskPk,
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
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const nameOfCategory = new Map(
    categories.map((category) => [
      ownerCategoryKey(category.ownerId, category.categoryId),
      category.name,
    ]),
  );
  const acc = new Map<
    string,
    { categoryId: string; categoryName: string; completed: number; total: number }
  >();
  for (const inst of instances) {
    const task = taskById.get(inst.taskId);
    const categoryId = task?.categoryId ?? 'unknown';
    const aggregateKey = task ? ownerCategoryKey(task.ownerId, task.categoryId) : 'unknown';
    const categoryName = task ? (nameOfCategory.get(aggregateKey) ?? categoryId) : 'unknown';
    const a = acc.get(aggregateKey) ?? {
      categoryId,
      categoryName,
      completed: 0,
      total: 0,
    };
    a.total++;
    if (inst.status === 'COMPLETED') a.completed++;
    acc.set(aggregateKey, a);
  }
  return [...acc.values()].map((a) => ({
    categoryId: a.categoryId,
    categoryName: a.categoryName,
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

/**
 * Per-step average ACTIVE time, from the server-authoritative step timers
 * (`TaskInstanceStep.activeDurationSeconds` — paused/idle gaps excluded). A step is a
 * sample once it has been started (`firstStartedAt`), completed or not: effort sunk into
 * an abandoned step is exactly the sticking-point signal this metric exists to surface.
 * Never-started steps and pre-timing (legacy) snapshots are not samples — raw legacy rows
 * lack the timing attributes entirely, so the `?? 0` covers reading them.
 */
export function aggregateStepDwell(
  steps: TaskInstanceStep[],
  tasks: Task[],
): ReportStats['stepDwell'] {
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  // key = `${taskId}#${order}` → accumulated seconds + sample count + step text
  const acc = new Map<
    string,
    { taskId: string; stepOrder: number; stepText: string; totalSeconds: number; samples: number }
  >();

  for (const s of steps) {
    if (!s.firstStartedAt) continue;
    const key = `${s.taskId}#${s.order}`;
    const a = acc.get(key) ?? {
      taskId: s.taskId,
      stepOrder: s.order,
      stepText: s.text,
      totalSeconds: 0,
      samples: 0,
    };
    a.totalSeconds += s.activeDurationSeconds ?? 0;
    a.samples++;
    acc.set(key, a);
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

/**
 * Per-task focused time from the instance-level timers, plus one overall focus ratio.
 * An instance is a sample when its raw row carries `activeDurationSeconds` (written from
 * materialization once server timing exists); pre-timing rows lack the attribute and are
 * excluded rather than counted as zero. The ratio is active ÷ wall-clock seconds summed
 * over COMPLETED instances with `elapsedSeconds` — low = the task was often interrupted
 * or left idle; null when no instance qualifies.
 */
export function aggregateFocus(instances: TaskInstance[], tasks: Task[]): ReportStats['focus'] {
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  const acc = new Map<string, { taskId: string; totalSeconds: number; samples: number }>();
  let activeSum = 0;
  let elapsedSum = 0;

  for (const inst of instances) {
    if (typeof inst.activeDurationSeconds !== 'number') continue; // legacy raw row
    const a = acc.get(inst.taskId) ?? { taskId: inst.taskId, totalSeconds: 0, samples: 0 };
    a.totalSeconds += inst.activeDurationSeconds;
    a.samples++;
    acc.set(inst.taskId, a);
    if (
      inst.status === 'COMPLETED' &&
      typeof inst.elapsedSeconds === 'number' &&
      inst.elapsedSeconds > 0
    ) {
      activeSum += inst.activeDurationSeconds;
      elapsedSum += inst.elapsedSeconds;
    }
  }

  return {
    byTask: [...acc.values()]
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map((a) => ({
        taskId: a.taskId,
        title: titleOf.get(a.taskId) ?? a.taskId,
        samples: a.samples,
        avgActiveSeconds: Math.round(a.totalSeconds / a.samples),
      })),
    focusRatio: elapsedSum === 0 ? null : rate(activeSum, elapsedSum),
  };
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
    stepDwell: aggregateStepDwell(steps, tasks),
    focus: aggregateFocus(instances, tasks),
    skipPatterns: aggregateSkipPatterns(instances, tasks),
    abandonment: aggregateAbandonment(instances, steps, tasks),
    timeOfDay: aggregateTimeOfDay(instances),
  };
}

/** A task/category pair is owner-scoped even though category ids are UUIDs. */
function ownerCategoryKey(ownerId: string, categoryId: string): string {
  return `${ownerId}\u0000${categoryId}`;
}

/**
 * Load the current metadata for every distinct task represented by the report's instances.
 * Task ids are globally keyed, so this works for the normal delegated flow where the Task is
 * owned by the SupportPerson but the TaskInstance lives in the primary user's partition.
 *
 * A deleted or malformed row is intentionally omitted: the aggregators already preserve the
 * instance counts and fall back to taskId / "unknown" metadata.
 */
async function loadInstanceTasks(instances: TaskInstance[]): Promise<Task[]> {
  const requestedIds = [...new Set(instances.map((instance) => instance.taskId))];
  if (requestedIds.length === 0) return [];

  const requested = new Set(requestedIds);
  const rows = await batchGet(requestedIds.map((taskId) => ({ PK: taskPk(taskId), SK: META_SK })));

  return rows.filter((row): row is Record<string, unknown> & Task => {
    const taskId = row.taskId;
    return (
      row.entityType === ENTITY.TASK &&
      typeof taskId === 'string' &&
      requested.has(taskId) &&
      row.PK === taskPk(taskId) &&
      row.SK === META_SK &&
      typeof row.ownerId === 'string' &&
      row.ownerId.length > 0 &&
      typeof row.title === 'string' &&
      typeof row.categoryId === 'string' &&
      row.categoryId.length > 0
    );
  });
}

/**
 * Load only the categories referenced by the resolved tasks. Category storage is owner-scoped,
 * so the owner/category pair is deduplicated and validated as a pair before its name is used.
 */
async function loadTaskCategories(tasks: Task[]): Promise<Category[]> {
  const requestedPairs = new Map<string, { ownerId: string; categoryId: string }>();
  for (const task of tasks) {
    requestedPairs.set(ownerCategoryKey(task.ownerId, task.categoryId), {
      ownerId: task.ownerId,
      categoryId: task.categoryId,
    });
  }
  if (requestedPairs.size === 0) return [];

  const rows = await batchGet(
    [...requestedPairs.values()].map(({ ownerId, categoryId }) => ({
      PK: userPk(ownerId),
      SK: categorySk(categoryId),
    })),
  );

  return rows.filter((row): row is Record<string, unknown> & Category => {
    if (
      row.entityType !== ENTITY.CATEGORY ||
      typeof row.ownerId !== 'string' ||
      typeof row.categoryId !== 'string' ||
      typeof row.name !== 'string'
    ) {
      return false;
    }
    const requested = requestedPairs.has(ownerCategoryKey(row.ownerId, row.categoryId));
    return requested && row.PK === userPk(row.ownerId) && row.SK === categorySk(row.categoryId);
  });
}

/**
 * Gather a user's task data for the range and compute the deterministic stats.
 * Instances use a single BETWEEN on the date-sorted SK and steps use a prefix scan of the
 * target user's partition. Task metadata is BatchGot by the distinct task ids represented in
 * those instances (tasks can be owned by the supporting person); only those tasks' exact
 * owner/category pairs are then BatchGot for category names.
 */
export async function buildReportStats(
  userId: string,
  from: string,
  to: string,
): Promise<ReportStats> {
  const pk = userPk(userId);
  const [instances, allSteps] = await Promise.all([
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
  ]);

  // Keep only step rows belonging to in-range instances (steps aren't date-keyed).
  const inRange = new Set(instances.map((i) => i.instanceId));
  const steps = allSteps.filter((s) => inRange.has(s.instanceId));
  const tasks = await loadInstanceTasks(instances);
  const categories = await loadTaskCategories(tasks);

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
