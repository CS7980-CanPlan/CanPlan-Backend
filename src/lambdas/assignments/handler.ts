import { randomUUID } from 'crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DateTime } from 'luxon';
import { presentAssignment } from '../../shared/assignment';
import { queryAllItems } from '../../shared/batch';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import {
  ENTITY,
  META_SK,
  STEP_PREFIX,
  TASK_ASSIGNMENT_PREFIX,
  TASK_INSTANCE_PREFIX,
  parseInstanceId,
  taskAssignmentSk,
  taskInstanceId,
  taskInstanceSk,
  taskInstanceStepPrefix,
  taskInstanceStepSk,
  taskPk,
  userPk,
} from '../../shared/keys';
import { pageArgs, type PageArgs, queryPage } from '../../shared/pagination';
import {
  expandOccurrences,
  normalizeSchedule,
  occurrenceFor,
  validateDateRange,
} from '../../shared/recurrence';
import { NotFoundError, ValidationError } from '../../shared/response';
import type {
  AppSyncEvent,
  AppSyncIdentity,
  CancelTaskInstanceInput,
  Connection,
  CreateTaskAssignmentInput,
  DeleteTaskAssignmentInput,
  EndTaskAssignmentInput,
  PersistedTaskInstanceStatus,
  SetTaskInstanceStepCompletionInput,
  StartTaskInstanceInput,
  TaskAssignment,
  TaskInstance,
  TaskInstanceStatus,
  TaskInstanceStep,
  TaskInstanceView,
  TaskStep,
  UpdateTaskInstanceStatusInput,
} from '../../shared/types';

/** A DynamoDB transaction may carry at most 100 items (1 TaskInstance + its step snapshots). */
const MAX_TRANSACTION_ITEMS = 100;
const MAX_INSTANCE_STEPS = MAX_TRANSACTION_ITEMS - 1;

/** Persisted instance statuses a client may set via updateTaskInstanceStatus. */
const SETTABLE_INSTANCE_STATUSES: readonly TaskInstanceStatus[] = ['IN_PROGRESS', 'COMPLETED', 'SKIPPED'];

/** A TaskInstance is terminal (frozen) once it reaches one of these. */
const TERMINAL_STATUSES: readonly PersistedTaskInstanceStatus[] = ['COMPLETED', 'SKIPPED', 'CANCELLED'];

type SchedulingResult =
  | TaskAssignment
  | TaskInstance
  | TaskInstanceStep
  | Connection<TaskAssignment>
  | Connection<TaskInstanceStep>
  | Connection<TaskInstanceView>;

/**
 * Scheduling domain Lambda — TaskAssignment (schedule rules), TaskInstance (concrete
 * occurrences), and TaskInstanceStep (per-occurrence step snapshots). A Task is a reusable
 * template only; all scheduling/status/step-completion state lives here. Routed by field.
 */
export const handler = async (
  event: AppSyncEvent<Record<string, unknown>>,
): Promise<SchedulingResult> => {
  const { arguments: args, identity } = event;
  switch (event.info?.fieldName) {
    case 'createTaskAssignment':
      return createTaskAssignment(args.input as CreateTaskAssignmentInput, identity);
    case 'startTaskInstance':
      return startTaskInstance(args.input as StartTaskInstanceInput);
    case 'setTaskInstanceStepCompletion':
      return setTaskInstanceStepCompletion(args.input as SetTaskInstanceStepCompletionInput);
    case 'updateTaskInstanceStatus':
      return updateTaskInstanceStatus(args.input as UpdateTaskInstanceStatusInput);
    case 'cancelTaskInstance':
      return cancelTaskInstance(args.input as CancelTaskInstanceInput);
    case 'endTaskAssignment':
      return endTaskAssignment(args.input as EndTaskAssignmentInput);
    case 'deleteTaskAssignment':
      return deleteTaskAssignment(args.input as DeleteTaskAssignmentInput);
    case 'listTaskAssignmentsForUser':
      return listTaskAssignmentsForUser(args.userId as string, pageArgs(args));
    case 'getTaskInstanceViews':
      return getTaskInstanceViews(
        args.userId as string,
        args.startDate as string,
        args.endDate as string,
      );
    case 'listTaskInstanceSteps':
      return listTaskInstanceSteps(args.userId as string, args.instanceId as string, pageArgs(args));
    default:
      throw new Error(`scheduling handler: unsupported field "${event.info?.fieldName}"`);
  }
};

// ── createTaskAssignment ────────────────────────────────────────────────────--

/**
 * Create a TaskAssignment (the schedule rule). Validates the source Task exists and the
 * schedule fields, then writes ONE row — it never materializes future TaskInstances. An
 * active assignment carries `activeTaskAssignmentTaskId` so deleteTask can detect it.
 */
async function createTaskAssignment(
  input: CreateTaskAssignmentInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskAssignment> {
  const taskId = input?.taskId?.trim();
  const userId = input?.userId?.trim();
  if (!taskId) throw new ValidationError('taskId is required and cannot be empty');
  if (!userId) throw new ValidationError('userId is required and cannot be empty');

  // Validate + normalize the schedule before any IO so bad input fails fast.
  const schedule = normalizeSchedule(input);

  // The referenced template must exist before we bind a schedule to it.
  const task = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  if (!task.Item) throw new NotFoundError(`task ${taskId} not found`);

  const assignmentId = randomUUID();
  const now = new Date().toISOString();
  const assignment: TaskAssignment = {
    assignmentId,
    taskId,
    userId,
    assignedBy: input.assignedBy?.trim() || identity?.sub?.trim(),
    scheduleType: schedule.scheduleType,
    scheduledFor: schedule.scheduledFor,
    scheduleRule: schedule.scheduleRule,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    startTime: schedule.startTime,
    timezone: schedule.timezone,
    active: true,
    // Sparse GSI marker: present only while active, so deleteTask can find active references.
    activeTaskAssignmentTaskId: taskId,
    assignedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPk(userId),
        SK: taskAssignmentSk(assignmentId),
        entityType: ENTITY.TASK_ASSIGNMENT,
        ...assignment,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return presentAssignment(assignment as unknown as Record<string, unknown>);
}

// ── startTaskInstance ───────────────────────────────────────────────────────--

/**
 * Materialize one occurrence. Verifies (assignmentId, scheduledDate, scheduledTime) is a real
 * occurrence of the assignment; if no TaskInstance exists yet, creates it (status IN_PROGRESS)
 * and snapshots the current TaskSteps into TaskInstanceStep rows in ONE transaction. Idempotent:
 * an already-started instance is returned unchanged (steps are never re-snapshotted).
 */
async function startTaskInstance(input: StartTaskInstanceInput): Promise<TaskInstance> {
  const { userId, assignmentId, scheduledDate, scheduledTime } = parseOccurrenceCoords(input);

  const assignment = await loadAssignment(userId, assignmentId);
  const occ = occurrenceFor(assignment, scheduledDate, scheduledTime);
  if (!occ) {
    throw new ValidationError(
      `no occurrence at ${scheduledDate} ${scheduledTime} for assignment ${assignmentId}`,
    );
  }

  // Idempotency: return an existing instance untouched (do not re-snapshot steps).
  const existing = await getInstance(userId, scheduledDate, scheduledTime, assignmentId);
  if (existing) return presentInstance(existing);

  const taskSteps = await loadTaskSteps(assignment.taskId);
  if (taskSteps.length > MAX_INSTANCE_STEPS) {
    throw new ValidationError(
      `task ${assignment.taskId} has ${taskSteps.length} steps; an instance may snapshot at most ` +
        `${MAX_INSTANCE_STEPS} steps (DynamoDB's 100-item transaction limit)`,
    );
  }

  const instanceId = taskInstanceId(assignmentId, scheduledDate, scheduledTime);
  const now = new Date().toISOString();
  const instance: TaskInstance = {
    instanceId,
    assignmentId,
    taskId: assignment.taskId,
    userId,
    scheduledDate,
    scheduledTime,
    scheduledFor: occ.scheduledFor,
    timezone: occ.timezone,
    status: 'IN_PROGRESS',
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // Step snapshots copy text/order only (NOT media — a live Task MediaAsset can be deleted).
  const steps: TaskInstanceStep[] = taskSteps.map((step) => ({
    instanceId,
    assignmentId,
    taskId: assignment.taskId,
    stepId: step.stepId,
    order: step.order,
    text: step.text,
    completed: false,
    createdAt: now,
    updatedAt: now,
  }));

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: userPk(userId),
                SK: taskInstanceSk(scheduledDate, scheduledTime, assignmentId),
                entityType: ENTITY.TASK_INSTANCE,
                ...instance,
              },
              // The instance must not already exist — guarantees we snapshot steps exactly once.
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...steps.map((step) => ({
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: userPk(userId),
                SK: taskInstanceStepSk(instanceId, step.stepId),
                entityType: ENTITY.TASK_INSTANCE_STEP,
                ...step,
              },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    // Lost a concurrent start race — the other writer created it. Return that instance.
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      const raced = await getInstance(userId, scheduledDate, scheduledTime, assignmentId);
      if (raced) return presentInstance(raced);
    }
    throw err;
  }

  return presentInstance(instance as unknown as Record<string, unknown>);
}

// ── setTaskInstanceStepCompletion ───────────────────────────────────────────--

/** Toggle one step's completion on an existing, non-terminal TaskInstance. */
async function setTaskInstanceStepCompletion(
  input: SetTaskInstanceStepCompletionInput,
): Promise<TaskInstanceStep> {
  const userId = input?.userId?.trim();
  const instanceId = input?.instanceId?.trim();
  const stepId = input?.stepId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!instanceId) throw new ValidationError('instanceId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');
  if (typeof input.completed !== 'boolean') throw new ValidationError('completed is required');

  const parsed = parseInstanceId(instanceId);
  if (!parsed) throw new ValidationError(`invalid instanceId "${instanceId}"`);

  const instance = await getInstance(
    userId,
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );
  if (!instance) throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
  const status = instance.status as PersistedTaskInstanceStatus;
  if (TERMINAL_STATUSES.includes(status)) {
    throw new ValidationError(`cannot change step completion on a ${status} instance`);
  }

  const now = new Date().toISOString();
  const updateExpression = input.completed
    ? 'SET completed = :completed, completedAt = :completedAt, updatedAt = :updatedAt'
    : 'SET completed = :completed, updatedAt = :updatedAt REMOVE completedAt';
  const values: Record<string, unknown> = { ':completed': input.completed, ':updatedAt': now };
  if (input.completed) values[':completedAt'] = now;

  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: taskInstanceStepSk(instanceId, stepId) },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripStorage(result.Attributes as Record<string, unknown>) as unknown as TaskInstanceStep;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`step ${stepId} not found for instance ${instanceId}`);
    }
    throw err;
  }
}

// ── updateTaskInstanceStatus ────────────────────────────────────────────────--

/**
 * Set a TaskInstance's status. Accepts IN_PROGRESS, COMPLETED, SKIPPED; OVERDUE is rejected
 * (derived) and CANCELLED must go through cancelTaskInstance. COMPLETED requires every step
 * complete (a zero-step instance may be completed). SKIPPED may be undone by moving back to
 * IN_PROGRESS; COMPLETED/CANCELLED remain frozen.
 */
async function updateTaskInstanceStatus(input: UpdateTaskInstanceStatusInput): Promise<TaskInstance> {
  const userId = input?.userId?.trim();
  const instanceId = input?.instanceId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!instanceId) throw new ValidationError('instanceId is required and cannot be empty');
  if (!input?.status) throw new ValidationError('status is required');
  if (input.status === 'OVERDUE') {
    throw new ValidationError('OVERDUE is a derived status and cannot be set');
  }
  if (input.status === 'CANCELLED') {
    throw new ValidationError('use cancelTaskInstance to cancel an occurrence');
  }
  if (!SETTABLE_INSTANCE_STATUSES.includes(input.status)) {
    throw new ValidationError(`status must be one of ${SETTABLE_INSTANCE_STATUSES.join(', ')}`);
  }
  const status = input.status as PersistedTaskInstanceStatus;
  const parsed = parseInstanceId(instanceId);
  if (!parsed) throw new ValidationError(`invalid instanceId "${instanceId}"`);

  // The instance must exist. Terminal instances are frozen except for the explicit "undo skip"
  // transition, which moves SKIPPED back to IN_PROGRESS and clears skippedAt below.
  const instance = await getInstance(
    userId,
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );
  if (!instance) throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
  const current = instance.status as PersistedTaskInstanceStatus;
  const isUndoSkip = current === 'SKIPPED' && status === 'IN_PROGRESS';
  if (TERMINAL_STATUSES.includes(current) && !isUndoSkip) {
    throw new ValidationError(`cannot change status of a ${current} instance`);
  }

  if (status === 'COMPLETED') {
    const steps = await loadInstanceSteps(userId, instanceId);
    if (steps.some((s) => !s.completed)) {
      throw new ValidationError(
        'cannot mark instance COMPLETED while one or more steps are incomplete',
      );
    }
  }

  const now = new Date().toISOString();
  const sets = ['#status = :status', '#updatedAt = :now'];
  // Clear any lifecycle timestamp that no longer matches the new status, so a transition
  // never leaves a stale completedAt/skippedAt behind.
  const removes: string[] = [];
  const values: Record<string, unknown> = { ':status': status, ':now': now };
  if (status === 'COMPLETED') {
    sets.push('completedAt = :now');
    removes.push('skippedAt');
  } else if (status === 'SKIPPED') {
    sets.push('skippedAt = :now');
    removes.push('completedAt');
  } else {
    // IN_PROGRESS: stamp startedAt the first time it begins; clear any terminal timestamps.
    sets.push('startedAt = if_not_exists(startedAt, :now)');
    removes.push('completedAt', 'skippedAt');
  }

  let updateExpression = `SET ${sets.join(', ')}`;
  if (removes.length) updateExpression += ` REMOVE ${removes.join(', ')}`;

  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: userPk(userId),
          SK: taskInstanceSk(parsed.scheduledDate, parsed.scheduledTime, parsed.assignmentId),
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return presentInstance(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
    }
    throw err;
  }
}

// ── cancelTaskInstance ──────────────────────────────────────────────────────--

/**
 * Cancel one occurrence. Creates (or overwrites) a real TaskInstance with status CANCELLED and
 * isException true, so the cancelled occurrence stops surfacing as an open virtual slot. A
 * terminal instance (COMPLETED/SKIPPED/CANCELLED) is frozen and cannot be cancelled — that would
 * clobber a finished occurrence and leave stale lifecycle timestamps behind.
 */
async function cancelTaskInstance(input: CancelTaskInstanceInput): Promise<TaskInstance> {
  const { userId, assignmentId, scheduledDate, scheduledTime } = parseOccurrenceCoords(input);

  const assignment = await loadAssignment(userId, assignmentId);
  const occ = occurrenceFor(assignment, scheduledDate, scheduledTime);
  if (!occ) {
    throw new ValidationError(
      `no occurrence at ${scheduledDate} ${scheduledTime} for assignment ${assignmentId}`,
    );
  }

  // A virtual occurrence (no row yet) is cancellable; an existing non-terminal one is too, but a
  // terminal instance must not be flipped to CANCELLED.
  const existing = await getInstance(userId, scheduledDate, scheduledTime, assignmentId);
  if (existing) {
    const current = existing.status as PersistedTaskInstanceStatus;
    if (TERMINAL_STATUSES.includes(current)) {
      throw new ValidationError(`cannot cancel a ${current} instance`);
    }
  }

  const instanceId = taskInstanceId(assignmentId, scheduledDate, scheduledTime);
  const now = new Date().toISOString();
  const result = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskInstanceSk(scheduledDate, scheduledTime, assignmentId) },
      // Upsert: create the exception row if it doesn't exist, or flip a non-terminal one to
      // CANCELLED. REMOVE clears any startedAt/completedAt/skippedAt so no stale lifecycle
      // timestamp survives the transition.
      UpdateExpression:
        'SET #status = :cancelled, isException = :true, cancelledAt = :now, updatedAt = :now, ' +
        'entityType = :entityType, instanceId = :instanceId, assignmentId = :assignmentId, ' +
        'taskId = :taskId, userId = :userId, scheduledDate = :scheduledDate, ' +
        'scheduledTime = :scheduledTime, scheduledFor = :scheduledFor, #tz = :timezone, ' +
        'createdAt = if_not_exists(createdAt, :now) REMOVE completedAt, skippedAt',
      ExpressionAttributeNames: { '#status': 'status', '#tz': 'timezone' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':true': true,
        ':now': now,
        ':entityType': ENTITY.TASK_INSTANCE,
        ':instanceId': instanceId,
        ':assignmentId': assignmentId,
        ':taskId': assignment.taskId,
        ':userId': userId,
        ':scheduledDate': scheduledDate,
        ':scheduledTime': scheduledTime,
        ':scheduledFor': occ.scheduledFor,
        ':timezone': occ.timezone,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return presentInstance(result.Attributes as Record<string, unknown>);
}

// ── endTaskAssignment ───────────────────────────────────────────────────────--

/**
 * End an assignment from `effectiveDate` onward. For a RECURRING assignment that still has
 * occurrence days before then, caps `endDate` to the day before (and keeps it active so prior
 * occurrences still surface). Otherwise the assignment is fully ended: active=false, endedAt
 * set, and the activeTaskAssignmentTaskId marker removed (unblocking task deletion).
 */
async function endTaskAssignment(input: EndTaskAssignmentInput): Promise<TaskAssignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  const effectiveDate = input?.effectiveDate?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  if (!effectiveDate) throw new ValidationError('effectiveDate is required and cannot be empty');
  const eff = DateTime.fromFormat(effectiveDate, 'yyyy-MM-dd', { zone: 'utc' });
  if (!eff.isValid) throw new ValidationError('effectiveDate must be a valid YYYY-MM-DD date');

  const assignment = await loadAssignment(userId, assignmentId);
  const now = new Date().toISOString();
  const newEndDate = eff.minus({ days: 1 }).toFormat('yyyy-MM-dd');

  const keepActive =
    assignment.scheduleType === 'RECURRING' &&
    !!assignment.startDate &&
    newEndDate >= assignment.startDate;

  let update;
  if (keepActive) {
    // Only ever shorten or preserve the window — never extend it. If an earlier endDate already
    // exists, keep it; a later effectiveDate must not push the schedule out.
    const cappedEndDate =
      assignment.endDate && assignment.endDate < newEndDate ? assignment.endDate : newEndDate;
    // Trim the window but leave the assignment active (and its task-deletion marker in place).
    update = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskAssignmentSk(assignmentId) },
      UpdateExpression: 'SET endDate = :endDate, updatedAt = :now',
      ExpressionAttributeValues: { ':endDate': cappedEndDate, ':now': now },
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    });
  } else {
    // Fully ended — deactivate and drop the sparse GSI marker so deleteTask is unblocked.
    const setEndDate = assignment.scheduleType === 'RECURRING' ? ', endDate = :endDate' : '';
    const values: Record<string, unknown> = { ':false': false, ':now': now };
    if (setEndDate) values[':endDate'] = newEndDate;
    update = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskAssignmentSk(assignmentId) },
      UpdateExpression: `SET active = :false, endedAt = :now, updatedAt = :now${setEndDate} REMOVE activeTaskAssignmentTaskId`,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    });
  }

  const result = await dynamo.send(update);
  return presentAssignment(result.Attributes as Record<string, unknown>);
}

// ── deleteTaskAssignment ────────────────────────────────────────────────────--

/** Soft-delete an assignment: active=false, endedAt=now, drop the activeTaskAssignmentTaskId marker. */
async function deleteTaskAssignment(input: DeleteTaskAssignmentInput): Promise<TaskAssignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');

  const now = new Date().toISOString();
  try {
    const result = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: taskAssignmentSk(assignmentId) },
        UpdateExpression:
          'SET active = :false, endedAt = :now, updatedAt = :now REMOVE activeTaskAssignmentTaskId',
        ExpressionAttributeValues: { ':false': false, ':now': now },
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return presentAssignment(result.Attributes as Record<string, unknown>);
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new NotFoundError(`assignment ${assignmentId} not found for user ${userId}`);
    }
    throw err;
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────--

async function listTaskAssignmentsForUser(
  userId: string,
  page: PageArgs,
): Promise<Connection<TaskAssignment>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  const result = await queryPage<Record<string, unknown>>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(userId.trim()), ':prefix': TASK_ASSIGNMENT_PREFIX },
    },
    page,
  );
  return { items: result.items.map(presentAssignment), nextToken: result.nextToken };
}

/**
 * getTaskInstanceViews — the calendar feed for a user over [startDate, endDate]. Expands every
 * ACTIVE assignment's virtual occurrences in the window, queries the real TaskInstance rows in
 * the same window, then overlays them: a real instance replaces its virtual slot, and any real
 * instance with no matching virtual occurrence (e.g. a cancelled exception) is still surfaced.
 */
async function getTaskInstanceViews(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<Connection<TaskInstanceView>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  const id = userId.trim();
  const { start, end } = validateDateRange(startDate, endDate);

  // 1) every assignment the user has (active + ended), 3) the real instances in the window.
  const [assignments, instances] = await Promise.all([
    queryAllItems<TaskAssignment>(userPk(id), TASK_ASSIGNMENT_PREFIX),
    queryInstancesInRange(id, start, end),
  ]);

  const assignmentById = new Map(assignments.map((a) => [a.assignmentId, a]));
  const instanceById = new Map(instances.map((i) => [i.instanceId, i]));
  const titles = await loadTaskTitles([...new Set(assignments.map((a) => a.taskId))]);
  const nowMs = Date.now();

  const views: TaskInstanceView[] = [];
  const covered = new Set<string>();

  // 2) + 4) + 5) virtual occurrences of active assignments, overlaid with real instances.
  for (const assignment of assignments) {
    const occurrences = expandOccurrences(assignment, start, end);
    for (const occ of occurrences) {
      const instanceId = taskInstanceId(assignment.assignmentId, occ.scheduledDate, occ.scheduledTime);
      covered.add(instanceId);
      const real = instanceById.get(instanceId);
      const title = titles.get(assignment.taskId) ?? '';
      if (real) {
        views.push(viewFromInstance(real, title, nowMs));
      } else {
        views.push({
          instanceId: null,
          assignmentId: assignment.assignmentId,
          taskId: assignment.taskId,
          userId: id,
          title,
          scheduledDate: occ.scheduledDate,
          scheduledTime: occ.scheduledTime,
          scheduledFor: occ.scheduledFor,
          timezone: occ.timezone,
          status: deriveInstanceStatus('TO_DO', occ.scheduledFor, nowMs),
          isVirtual: true,
          isException: false,
        });
      }
    }
  }

  // Real instances with no matching virtual slot (cancelled exceptions, ended assignments, …).
  for (const inst of instances) {
    if (covered.has(inst.instanceId)) continue;
    const title = titles.get(inst.taskId) ?? titles.get(assignmentById.get(inst.assignmentId)?.taskId ?? '') ?? '';
    views.push(viewFromInstance(inst, title, nowMs));
  }

  views.sort((a, b) =>
    a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : 0,
  );
  return { items: views, nextToken: null };
}

async function listTaskInstanceSteps(
  userId: string,
  instanceId: string,
  page: PageArgs,
): Promise<Connection<TaskInstanceStep>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  if (!instanceId?.trim()) throw new ValidationError('instanceId is required');

  const result = await queryPage<TaskInstanceStep>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': userPk(userId.trim()),
        ':prefix': taskInstanceStepPrefix(instanceId.trim()),
      },
    },
    page,
  );
  result.items = result.items
    .map((s) => stripStorage(s as unknown as Record<string, unknown>) as unknown as TaskInstanceStep)
    .sort((a, b) => a.order - b.order);
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────--

/** Validate the (userId, assignmentId, scheduledDate, scheduledTime) occurrence coordinates. */
function parseOccurrenceCoords(input: {
  userId?: string;
  assignmentId?: string;
  scheduledDate?: string;
  scheduledTime?: string;
}): { userId: string; assignmentId: string; scheduledDate: string; scheduledTime: string } {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  const scheduledDate = input?.scheduledDate?.trim();
  const scheduledTime = input?.scheduledTime?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  if (!scheduledDate) throw new ValidationError('scheduledDate is required and cannot be empty');
  if (!scheduledTime) throw new ValidationError('scheduledTime is required and cannot be empty');
  return { userId, assignmentId, scheduledDate, scheduledTime };
}

/** Load one TaskAssignment row (with PK/SK), or throw NotFound. */
async function loadAssignment(userId: string, assignmentId: string): Promise<TaskAssignment> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskAssignmentSk(assignmentId) },
    }),
  );
  if (!result.Item) {
    throw new NotFoundError(`assignment ${assignmentId} not found for user ${userId}`);
  }
  return result.Item as TaskAssignment;
}

/** Read one TaskInstance by its occurrence coordinates (undefined if absent). */
async function getInstance(
  userId: string,
  scheduledDate: string,
  scheduledTime: string,
  assignmentId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskInstanceSk(scheduledDate, scheduledTime, assignmentId) },
    }),
  );
  return result.Item as Record<string, unknown> | undefined;
}

/** Query the real TaskInstance rows whose scheduledDate falls in [start, end] (date-sorted SK). */
async function queryInstancesInRange(
  userId: string,
  start: string,
  end: string,
): Promise<TaskInstance[]> {
  const items: TaskInstance[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': userPk(userId),
          ':lo': `${TASK_INSTANCE_PREFIX}${start}`,
          // '￿' sorts above every real SK suffix, so all times on `end` are included.
          ':hi': `${TASK_INSTANCE_PREFIX}${end}#￿`,
        },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((result.Items as TaskInstance[]) ?? []));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

/** Fetch the titles of the given tasks, keyed by taskId (missing/deleted tasks are omitted). */
async function loadTaskTitles(taskIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  await Promise.all(
    taskIds.map(async (taskId) => {
      const result = await dynamo.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: taskPk(taskId), SK: META_SK },
          ProjectionExpression: 'title',
        }),
      );
      const title = (result.Item as { title?: string } | undefined)?.title;
      if (title != null) titles.set(taskId, title);
    }),
  );
  return titles;
}

/** Read every TaskStep of a template (follows pagination) for the per-instance snapshot. */
async function loadTaskSteps(taskId: string): Promise<TaskStep[]> {
  return queryAllItems<TaskStep>(taskPk(taskId), STEP_PREFIX);
}

/** Read every TaskInstanceStep of one instance (follows pagination). */
async function loadInstanceSteps(userId: string, instanceId: string): Promise<TaskInstanceStep[]> {
  return queryAllItems<TaskInstanceStep>(userPk(userId), taskInstanceStepPrefix(instanceId));
}

/**
 * Derive the API-facing status for an occurrence/instance. A non-terminal occurrence whose
 * scheduledFor is in the past surfaces as OVERDUE; terminal statuses pass through unchanged.
 */
export function deriveInstanceStatus(
  persisted: PersistedTaskInstanceStatus,
  scheduledFor: string | undefined,
  nowMs: number,
): TaskInstanceStatus {
  if (TERMINAL_STATUSES.includes(persisted)) return persisted;
  if (!scheduledFor) return persisted;
  const at = Date.parse(scheduledFor);
  return Number.isNaN(at) || at >= nowMs ? persisted : 'OVERDUE';
}

/** Project a stored TaskInstance row into a calendar view (status derived). */
function viewFromInstance(
  inst: TaskInstance,
  title: string,
  nowMs: number,
): TaskInstanceView {
  return {
    instanceId: inst.instanceId,
    assignmentId: inst.assignmentId,
    taskId: inst.taskId,
    userId: inst.userId,
    title,
    scheduledDate: inst.scheduledDate,
    scheduledTime: inst.scheduledTime,
    scheduledFor: inst.scheduledFor,
    timezone: inst.timezone,
    status: deriveInstanceStatus(inst.status, inst.scheduledFor, nowMs),
    isVirtual: false,
    isException: inst.isException ?? false,
  };
}

/** Strip internal storage attributes (PK/SK/entityType) from a row. */
function stripStorage(item: Record<string, unknown>): Record<string, unknown> {
  const out = { ...item };
  delete out.PK;
  delete out.SK;
  delete out.entityType;
  return out;
}

/** Project a stored TaskInstance row into the API shape (storage attributes stripped). */
function presentInstance(item: Record<string, unknown>): TaskInstance {
  return stripStorage(item) as unknown as TaskInstance;
}
