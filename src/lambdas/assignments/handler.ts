import { randomUUID } from 'crypto';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DateTime } from 'luxon';
import { presentAssignment } from '../../shared/assignment';
import { assertCallerOwns, requireCaller } from '../../shared/authz';
import { queryAllItems } from '../../shared/batch';
import { assertCanActForUser } from '../../shared/delegation';
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
  taskInstanceSkFromId,
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
  PauseTaskInstanceTimerInput,
  PersistedTaskInstanceStatus,
  SetTaskInstanceStepCompletionInput,
  StartTaskInstanceInput,
  StartTaskInstanceStepInput,
  TaskAssignment,
  TaskInstance,
  TaskInstanceLookupResult,
  TaskInstanceStatus,
  TaskInstanceStep,
  TaskInstanceTimingResult,
  TaskInstanceView,
  TaskStep,
  UpdateTaskInstanceStatusInput,
} from '../../shared/types';

/** A DynamoDB transaction may carry at most 100 items (1 TaskInstance + its step snapshots). */
const MAX_TRANSACTION_ITEMS = 100;
const MAX_INSTANCE_STEPS = MAX_TRANSACTION_ITEMS - 1;

/** Persisted instance statuses a client may set via updateTaskInstanceStatus. */
const SETTABLE_INSTANCE_STATUSES: readonly TaskInstanceStatus[] = [
  'IN_PROGRESS',
  'COMPLETED',
  'SKIPPED',
];

/** A TaskInstance is terminal (frozen) once it reaches one of these. */
const TERMINAL_STATUSES: readonly PersistedTaskInstanceStatus[] = [
  'COMPLETED',
  'SKIPPED',
  'CANCELLED',
];

/**
 * Bounded retries for an active-step close that lost an optimistic-concurrency race. Each retry
 * re-reads the instance, so it converges fast: the writer that won has already moved/cleared the
 * pointer, so the re-read either finds nothing to close or a new pointer to close instead.
 */
const MAX_TIMING_RETRIES = 5;

/** batchGetTaskInstances accepts at most this many ids per request (also DynamoDB's BatchGet cap). */
const MAX_BATCH_GET_INSTANCES = 100;

type SchedulingResult =
  | TaskAssignment
  | TaskInstance
  | TaskInstanceStep
  | TaskInstanceTimingResult
  | Connection<TaskAssignment>
  | Connection<TaskInstance>
  | Connection<TaskInstanceStep>
  | Connection<TaskInstanceView>
  | TaskInstanceLookupResult[]
  | null;

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
      return startTaskInstance(args.input as StartTaskInstanceInput, identity);
    case 'setTaskInstanceStepCompletion':
      return setTaskInstanceStepCompletion(
        args.input as SetTaskInstanceStepCompletionInput,
        identity,
      );
    case 'startTaskInstanceStep':
      return startTaskInstanceStep(args.input as StartTaskInstanceStepInput, identity);
    case 'pauseTaskInstanceTimer':
      return pauseTaskInstanceTimer(args.input as PauseTaskInstanceTimerInput, identity);
    case 'updateTaskInstanceStatus':
      return updateTaskInstanceStatus(args.input as UpdateTaskInstanceStatusInput, identity);
    case 'cancelTaskInstance':
      return cancelTaskInstance(args.input as CancelTaskInstanceInput, identity);
    case 'endTaskAssignment':
      return endTaskAssignment(args.input as EndTaskAssignmentInput, identity);
    case 'deleteTaskAssignment':
      return deleteTaskAssignment(args.input as DeleteTaskAssignmentInput, identity);
    case 'listTaskAssignmentsForUser':
      return listTaskAssignmentsForUser(args.userId as string, pageArgs(args), identity);
    case 'getTaskInstanceViews':
      return getTaskInstanceViews(
        args.userId as string,
        args.startDate as string,
        args.endDate as string,
        identity,
      );
    case 'getTaskInstance':
      return getTaskInstance(
        identity,
        args.instanceId as string,
        args.userId as string | null | undefined,
      );
    case 'listTaskInstances':
      return listTaskInstances(
        identity,
        args.startDate as string,
        args.endDate as string,
        pageArgs(args),
        args.userId as string | null | undefined,
      );
    case 'batchGetTaskInstances':
      return batchGetTaskInstances(
        identity,
        args.instanceIds as string[],
        args.userId as string | null | undefined,
      );
    case 'listTaskInstanceSteps':
      return listTaskInstanceSteps(
        args.userId as string,
        args.instanceId as string,
        pageArgs(args),
        identity,
      );
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

  // The caller may only assign to themselves or through effective delegation to a primary user.
  const caller = requireCaller(identity);
  await assertCanActForUser(identity, userId);

  // Validate + normalize the schedule before any further IO so bad input fails fast.
  const schedule = normalizeSchedule(input);

  // The referenced template must exist AND be owned by the caller — a SupportPerson schedules
  // their OWN task template for a primary user they can currently act for. The assignment references the template
  // by id; it is never copied into the primary user's account.
  const task = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: taskPk(taskId), SK: META_SK } }),
  );
  if (!task.Item) throw new NotFoundError(`task ${taskId} not found`);
  assertCallerOwns(identity, (task.Item as { ownerId: string }).ownerId);

  const assignmentId = randomUUID();
  const now = new Date().toISOString();
  const assignment: TaskAssignment = {
    assignmentId,
    taskId,
    userId,
    // assignedBy is ALWAYS the caller's identity — never trusted from input.
    assignedBy: caller,
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
async function startTaskInstance(
  input: StartTaskInstanceInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskInstance> {
  const { userId, assignmentId, scheduledDate, scheduledTime } = parseOccurrenceCoords(input);
  await assertCanActForUser(identity, userId);

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
    // Active timing starts at zero; no step is active until startTaskInstanceStep is called.
    activeDurationSeconds: 0,
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
    activeDurationSeconds: 0,
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
  identity: AppSyncIdentity | undefined,
): Promise<TaskInstanceStep> {
  const userId = input?.userId?.trim();
  const instanceId = input?.instanceId?.trim();
  const stepId = input?.stepId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!instanceId) throw new ValidationError('instanceId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');
  if (typeof input.completed !== 'boolean') throw new ValidationError('completed is required');
  await assertCanActForUser(identity, userId);

  const parsed = parseInstanceId(instanceId);
  if (!parsed) throw new ValidationError(`invalid instanceId "${instanceId}"`);
  const instanceSk = taskInstanceSk(
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );

  for (let attempt = 0; ; attempt++) {
    const instance = await getInstance(
      userId,
      parsed.scheduledDate,
      parsed.scheduledTime,
      parsed.assignmentId,
    );
    if (!instance)
      throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
    const status = instance.status as PersistedTaskInstanceStatus;
    if (TERMINAL_STATUSES.includes(status)) {
      throw new ValidationError(`cannot change step completion on a ${status} instance`);
    }

    const now = new Date().toISOString();

    // Completing the step whose timer is currently running: close it first — accumulate its active
    // seconds onto the step and the instance and clear the active pointer — in ONE transaction. The
    // instance update is guarded on the exact pointer observed so a concurrent close (e.g. a racing
    // pauseTaskInstanceTimer) can't double-count the interval; a lost race re-reads and, seeing the
    // step no longer active, falls through to the plain completion below (adding no extra duration).
    if (input.completed && instance.activeStepId === stepId && instance.activeStepStartedAt) {
      const step = await loadInstanceStep(userId, instanceId, stepId);
      if (!step) throw new NotFoundError(`step ${stepId} not found for instance ${instanceId}`);
      const delta = elapsedSecondsBetween(instance.activeStepStartedAt as string, now);
      const guard = activePointerGuard(instance);
      try {
        await dynamo.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: TABLE_NAME,
                  Key: { PK: userPk(userId), SK: taskInstanceStepSk(instanceId, stepId) },
                  UpdateExpression:
                    'SET completed = :true, completedAt = :now, ' +
                    'activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta, ' +
                    'updatedAt = :now',
                  ExpressionAttributeValues: {
                    ':true': true,
                    ':now': now,
                    ':zero': 0,
                    ':delta': delta,
                  },
                  ConditionExpression: 'attribute_exists(PK)',
                },
              },
              {
                Update: {
                  TableName: TABLE_NAME,
                  Key: { PK: userPk(userId), SK: instanceSk },
                  UpdateExpression:
                    'SET activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta, ' +
                    'updatedAt = :now REMOVE activeStepId, activeStepStartedAt',
                  ExpressionAttributeValues: {
                    ':zero': 0,
                    ':delta': delta,
                    ':now': now,
                    ...guard.values,
                  },
                  ConditionExpression: `attribute_exists(PK) AND ${guard.condition}`,
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (isOptimisticConflict(err) && attempt < MAX_TIMING_RETRIES) continue;
        throw err;
      }
      return presentStep({
        ...step,
        completed: true,
        completedAt: now,
        activeDurationSeconds: numberOr(step.activeDurationSeconds, 0) + delta,
        updatedAt: now,
      });
    }

    // Otherwise a plain toggle — completing a non-active step adds no duration; uncompleting only
    // clears completedAt (prior activeDurationSeconds is preserved, never subtracted). This touches
    // only the step row (not the instance pointer), so it needs no optimistic guard.
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
      return presentStep(result.Attributes as Record<string, unknown>);
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new NotFoundError(`step ${stepId} not found for instance ${instanceId}`);
      }
      throw err;
    }
  }
}

// ── startTaskInstanceStep / pauseTaskInstanceTimer (active-step timing) ────────--

/**
 * Start (or switch to) one step's timer on a non-terminal instance. Server time only — client
 * durations are never trusted. Idempotent when the requested step is already active. When a
 * different step is active it is closed first: its running interval (serverNow −
 * activeStepStartedAt) is accumulated onto that step AND the instance, then the new step is
 * pointed to and its firstStartedAt/lastStartedAt stamped — all in one transaction.
 */
async function startTaskInstanceStep(
  input: StartTaskInstanceStepInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskInstanceTimingResult> {
  const userId = input?.userId?.trim();
  const instanceId = input?.instanceId?.trim();
  const stepId = input?.stepId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!instanceId) throw new ValidationError('instanceId is required and cannot be empty');
  if (!stepId) throw new ValidationError('stepId is required and cannot be empty');
  await assertCanActForUser(identity, userId);

  const parsed = parseInstanceId(instanceId);
  if (!parsed) throw new ValidationError(`invalid instanceId "${instanceId}"`);
  const instanceSk = taskInstanceSk(
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );

  // Re-read + re-plan on each attempt: the instance write is guarded on the active pointer we
  // observed, so a concurrent close/switch fails the condition and we retry against fresh state.
  for (let attempt = 0; ; attempt++) {
    const instance = await getInstance(
      userId,
      parsed.scheduledDate,
      parsed.scheduledTime,
      parsed.assignmentId,
    );
    if (!instance)
      throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
    const status = instance.status as PersistedTaskInstanceStatus;
    if (TERMINAL_STATUSES.includes(status)) {
      throw new ValidationError(`cannot change timing on a ${status} instance`);
    }

    const activeStepId = instance.activeStepId as string | undefined;
    const now = new Date().toISOString();

    // Idempotent: the requested step is already running — return current state untouched.
    if (activeStepId === stepId) {
      const step = await loadInstanceStep(userId, instanceId, stepId);
      if (!step) throw new NotFoundError(`step ${stepId} not found for instance ${instanceId}`);
      return {
        instance: presentInstance(instance),
        activeStep: presentStep(step),
        previousStep: null,
      };
    }

    // The step being started must be a real snapshot on this instance.
    const newStep = await loadInstanceStep(userId, instanceId, stepId);
    if (!newStep) throw new NotFoundError(`step ${stepId} not found for instance ${instanceId}`);

    // If a different step is running, close it first and accumulate its active seconds. A stale
    // pointer (its snapshot is gone) is simply re-pointed to the new step, counting nothing.
    let previousStep: Record<string, unknown> | undefined;
    if (activeStepId && instance.activeStepStartedAt) {
      previousStep = await loadInstanceStep(userId, instanceId, activeStepId);
    }
    const plan = planActiveStepClose(userId, instanceId, instance, previousStep, now);
    const delta = plan?.delta ?? 0;
    const guard = activePointerGuard(instance);

    const txItems: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [
      {
        // Point the instance's active pointer at the new step; fold in the closed step's delta.
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(userId), SK: instanceSk },
          UpdateExpression:
            'SET activeStepId = :stepId, activeStepStartedAt = :now, ' +
            'activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta, ' +
            'updatedAt = :now',
          ExpressionAttributeValues: {
            ':stepId': stepId,
            ':now': now,
            ':zero': 0,
            ':delta': delta,
            ...guard.values,
          },
          ConditionExpression: `attribute_exists(PK) AND ${guard.condition}`,
        },
      },
      {
        // Start the new step: stamp firstStartedAt once, always refresh lastStartedAt.
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(userId), SK: taskInstanceStepSk(instanceId, stepId) },
          UpdateExpression:
            'SET firstStartedAt = if_not_exists(firstStartedAt, :now), lastStartedAt = :now, ' +
            'activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero), updatedAt = :now',
          ExpressionAttributeValues: { ':now': now, ':zero': 0 },
          ConditionExpression: 'attribute_exists(PK)',
        },
      },
    ];
    if (plan?.stepTxItem) {
      txItems.push(plan.stepTxItem);
    }

    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: txItems }));
    } catch (err) {
      if (isOptimisticConflict(err) && attempt < MAX_TIMING_RETRIES) continue;
      throw err;
    }

    const instanceResult = presentInstance({
      ...instance,
      activeStepId: stepId,
      activeStepStartedAt: now,
      activeDurationSeconds: numberOr(instance.activeDurationSeconds, 0) + delta,
      updatedAt: now,
    });
    const activeStepResult = presentStep({
      ...newStep,
      firstStartedAt: (newStep.firstStartedAt as string | undefined) ?? now,
      lastStartedAt: now,
      updatedAt: now,
    });
    // Only report a closed previous step when its snapshot actually existed (delta was accumulated).
    const previousStepResult =
      plan?.stepTxItem && previousStep
        ? presentStep({
            ...previousStep,
            activeDurationSeconds: numberOr(previousStep.activeDurationSeconds, 0) + delta,
            updatedAt: now,
          })
        : null;

    return {
      instance: instanceResult,
      activeStep: activeStepResult,
      previousStep: previousStepResult,
    };
  }
}

/**
 * Pause an instance's active-step timer (app backgrounded, task page left, screen locked, or a
 * manual pause). Closes the active step — accumulating its running interval onto the step and the
 * instance — and clears the active pointer, in one transaction. Idempotent when nothing is active.
 * The instance write is guarded on the exact pointer observed, so a concurrent close can't cause
 * the same interval to be counted twice; a lost race re-reads and converges (usually to a no-op).
 */
async function pauseTaskInstanceTimer(
  input: PauseTaskInstanceTimerInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskInstanceTimingResult> {
  const userId = input?.userId?.trim();
  const instanceId = input?.instanceId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!instanceId) throw new ValidationError('instanceId is required and cannot be empty');
  await assertCanActForUser(identity, userId);

  const parsed = parseInstanceId(instanceId);
  if (!parsed) throw new ValidationError(`invalid instanceId "${instanceId}"`);
  const instanceSk = taskInstanceSk(
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );

  for (let attempt = 0; ; attempt++) {
    const instance = await getInstance(
      userId,
      parsed.scheduledDate,
      parsed.scheduledTime,
      parsed.assignmentId,
    );
    if (!instance)
      throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
    const status = instance.status as PersistedTaskInstanceStatus;
    if (TERMINAL_STATUSES.includes(status)) {
      throw new ValidationError(`cannot change timing on a ${status} instance`);
    }

    const activeStepId = instance.activeStepId as string | undefined;
    const now = new Date().toISOString();

    // Idempotent: no pointer at all. (A pointer with no startedAt is corrupt — it still needs
    // clearing, so fall through rather than short-circuiting here.)
    if (!activeStepId) {
      return { instance: presentInstance(instance), activeStep: null, previousStep: null };
    }

    // Close the running step (a stale/corrupt pointer is simply cleared, uncounted).
    const activeStep = instance.activeStepStartedAt
      ? await loadInstanceStep(userId, instanceId, activeStepId)
      : undefined;
    const plan = planActiveStepClose(userId, instanceId, instance, activeStep, now);
    const delta = plan?.delta ?? 0;
    const guard = activePointerGuard(instance);

    const txItems: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [
      {
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: userPk(userId), SK: instanceSk },
          UpdateExpression:
            'SET activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta, ' +
            'updatedAt = :now REMOVE activeStepId, activeStepStartedAt',
          ExpressionAttributeValues: { ':zero': 0, ':delta': delta, ':now': now, ...guard.values },
          ConditionExpression: `attribute_exists(PK) AND ${guard.condition}`,
        },
      },
    ];
    if (plan?.stepTxItem) {
      txItems.push(plan.stepTxItem);
    }
    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: txItems }));
    } catch (err) {
      if (isOptimisticConflict(err) && attempt < MAX_TIMING_RETRIES) continue;
      throw err;
    }

    const merged: Record<string, unknown> = {
      ...instance,
      activeDurationSeconds: numberOr(instance.activeDurationSeconds, 0) + delta,
      updatedAt: now,
    };
    delete merged.activeStepId;
    delete merged.activeStepStartedAt;
    const previousStepResult =
      plan?.stepTxItem && activeStep
        ? presentStep({
            ...activeStep,
            activeDurationSeconds: numberOr(activeStep.activeDurationSeconds, 0) + delta,
            updatedAt: now,
          })
        : null;

    return {
      instance: presentInstance(merged),
      activeStep: null,
      previousStep: previousStepResult,
    };
  }
}

// ── updateTaskInstanceStatus ────────────────────────────────────────────────--

/**
 * Set a TaskInstance's status. Accepts IN_PROGRESS, COMPLETED, SKIPPED; OVERDUE is rejected
 * (derived) and CANCELLED must go through cancelTaskInstance. COMPLETED requires every step
 * complete (a zero-step instance may be completed). SKIPPED may be undone by moving back to
 * IN_PROGRESS; COMPLETED/CANCELLED remain frozen.
 */
async function updateTaskInstanceStatus(
  input: UpdateTaskInstanceStatusInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskInstance> {
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
  await assertCanActForUser(identity, userId);
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
  if (!instance)
    throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
  const current = instance.status as PersistedTaskInstanceStatus;
  const isUndoSkip = current === 'SKIPPED' && status === 'IN_PROGRESS';
  if (TERMINAL_STATUSES.includes(current) && !isUndoSkip) {
    throw new ValidationError(`cannot change status of a ${current} instance`);
  }

  const now = new Date().toISOString();

  if (status === 'COMPLETED') {
    const steps = await loadInstanceSteps(userId, instanceId);
    if (steps.some((s) => !s.completed)) {
      throw new ValidationError(
        'cannot mark instance COMPLETED while one or more steps are incomplete',
      );
    }
  }

  // COMPLETED and SKIPPED are terminal: both must finalize timing (close any running step, clear
  // the active pointer) so a terminal instance never looks like a step timer is still active.
  if (status === 'COMPLETED' || status === 'SKIPPED') {
    return finalizeInstance(userId, parsed, instance, status);
  }

  // IN_PROGRESS (incl. undo-skip): stamp startedAt the first time it begins; clear terminal
  // timestamps. The active pointer is left as-is — re-affirming IN_PROGRESS must not drop a
  // running timer (a SKIPPED instance already had its timer closed, so undo-skip has none).
  const updateExpression =
    'SET #status = :status, #updatedAt = :now, startedAt = if_not_exists(startedAt, :now) ' +
    'REMOVE completedAt, skippedAt';
  const values: Record<string, unknown> = { ':status': status, ':now': now };

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

/**
 * Apply a terminal transition (COMPLETED or SKIPPED) and finalize timing: close any running step
 * (accumulate its interval onto both the step and the instance), stamp the terminal timestamp,
 * clear the active pointer, and clear the opposite terminal timestamp. COMPLETED additionally
 * records `elapsedSeconds` (wall-clock startedAt→now). A stale active pointer (its snapshot is
 * missing) is cleared WITHOUT counting; a genuinely running step is closed in one transaction so a
 * terminal instance never leaves a step timer looking active.
 *
 * `instance0` is the row already read + validated by the caller (used on the first attempt). The
 * instance write is guarded on the exact active pointer observed, so a concurrent close/switch can't
 * double-count the interval; on a lost race we re-read and re-plan against fresh state.
 */
async function finalizeInstance(
  userId: string,
  parsed: { assignmentId: string; scheduledDate: string; scheduledTime: string },
  instance0: Record<string, unknown>,
  target: 'COMPLETED' | 'SKIPPED',
): Promise<TaskInstance> {
  const instanceSk = taskInstanceSk(
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );
  const instanceId = instance0.instanceId as string;
  const isCompleted = target === 'COMPLETED';

  for (let attempt = 0; ; attempt++) {
    let instance = instance0;
    if (attempt > 0) {
      const reread = await getInstance(
        userId,
        parsed.scheduledDate,
        parsed.scheduledTime,
        parsed.assignmentId,
      );
      if (!reread)
        throw new NotFoundError(`task instance ${instanceId} not found for user ${userId}`);
      // A concurrent writer already reached a terminal state — stop fighting; return current state.
      if (TERMINAL_STATUSES.includes(reread.status as PersistedTaskInstanceStatus)) {
        return presentInstance(reread);
      }
      instance = reread;
    }

    const now = new Date().toISOString();
    const activeStepId = instance.activeStepId as string | undefined;
    const activeStep =
      activeStepId && instance.activeStepStartedAt
        ? await loadInstanceStep(userId, instanceId, activeStepId)
        : undefined;
    const plan = planActiveStepClose(userId, instanceId, instance, activeStep, now);
    const delta = plan?.delta ?? 0;

    const elapsed =
      isCompleted && instance.startedAt
        ? elapsedSecondsBetween(instance.startedAt as string, now)
        : 0;
    const setStamp = isCompleted
      ? 'completedAt = :now, elapsedSeconds = :elapsed'
      : 'skippedAt = :now';
    const removeStamp = isCompleted ? 'skippedAt' : 'completedAt';
    const guard = activePointerGuard(instance);

    const values: Record<string, unknown> = { ':status': target, ':now': now, ...guard.values };
    if (isCompleted) values[':elapsed'] = elapsed;
    // Only touch activeDurationSeconds when a real running step is being closed.
    const accum = plan?.stepTxItem
      ? ', activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta'
      : '';
    if (plan?.stepTxItem) {
      values[':zero'] = 0;
      values[':delta'] = delta;
    }
    const updateExpression =
      `SET #status = :status, #updatedAt = :now, ${setStamp}${accum} ` +
      `REMOVE ${removeStamp}, activeStepId, activeStepStartedAt`;
    const instanceUpdate = {
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: instanceSk },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: values,
      ConditionExpression: `attribute_exists(PK) AND ${guard.condition}`,
    };

    try {
      // No running step to accumulate (nothing active, or a stale pointer we simply clear): one
      // update. Otherwise close the step and finalize atomically.
      if (!plan?.stepTxItem) {
        const result = await dynamo.send(
          new UpdateCommand({ ...instanceUpdate, ReturnValues: 'ALL_NEW' }),
        );
        return presentInstance(result.Attributes as Record<string, unknown>);
      }
      await dynamo.send(
        new TransactWriteCommand({ TransactItems: [{ Update: instanceUpdate }, plan.stepTxItem] }),
      );
    } catch (err) {
      if (isOptimisticConflict(err) && attempt < MAX_TIMING_RETRIES) continue;
      throw err;
    }

    const merged: Record<string, unknown> = {
      ...instance,
      status: target,
      activeDurationSeconds: numberOr(instance.activeDurationSeconds, 0) + delta,
      updatedAt: now,
    };
    if (isCompleted) {
      merged.completedAt = now;
      merged.elapsedSeconds = elapsed;
      delete merged.skippedAt;
    } else {
      merged.skippedAt = now;
      delete merged.completedAt;
    }
    delete merged.activeStepId;
    delete merged.activeStepStartedAt;
    return presentInstance(merged);
  }
}

// ── cancelTaskInstance ──────────────────────────────────────────────────────--

/**
 * Cancel one occurrence. Creates (or overwrites) a real TaskInstance with status CANCELLED and
 * isException true, so the cancelled occurrence stops surfacing as an open virtual slot. A
 * terminal instance (COMPLETED/SKIPPED/CANCELLED) is frozen and cannot be cancelled — that would
 * clobber a finished occurrence and leave stale lifecycle timestamps behind.
 */
async function cancelTaskInstance(
  input: CancelTaskInstanceInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskInstance> {
  const { userId, assignmentId, scheduledDate, scheduledTime } = parseOccurrenceCoords(input);
  await assertCanActForUser(identity, userId);

  const assignment = await loadAssignment(userId, assignmentId);
  const occ = occurrenceFor(assignment, scheduledDate, scheduledTime);
  if (!occ) {
    throw new ValidationError(
      `no occurrence at ${scheduledDate} ${scheduledTime} for assignment ${assignmentId}`,
    );
  }

  const instanceId = taskInstanceId(assignmentId, scheduledDate, scheduledTime);
  const instanceSk = taskInstanceSk(scheduledDate, scheduledTime, assignmentId);

  for (let attempt = 0; ; attempt++) {
    // A virtual occurrence (no row yet) is cancellable; an existing non-terminal one is too, but a
    // terminal instance must not be flipped to CANCELLED.
    const existing = await getInstance(userId, scheduledDate, scheduledTime, assignmentId);
    if (existing) {
      const current = existing.status as PersistedTaskInstanceStatus;
      if (TERMINAL_STATUSES.includes(current)) {
        throw new ValidationError(`cannot cancel a ${current} instance`);
      }
    }

    const now = new Date().toISOString();

    // If the existing instance has a step timer running, close it first (accumulating its final
    // interval) so the cancelled instance never keeps a step looking active. A stale/corrupt pointer
    // (or a virtual occurrence with no row) needs no accumulation — the SET/REMOVE below clears it.
    const plan =
      existing && existing.activeStepId
        ? planActiveStepClose(
            userId,
            instanceId,
            existing,
            existing.activeStepStartedAt
              ? await loadInstanceStep(userId, instanceId, existing.activeStepId as string)
              : undefined,
            now,
          )
        : null;
    const delta = plan?.delta ?? 0;
    // Guard the upsert on the exact active pointer we observed so a concurrent start can't slip a
    // running timer past the cancel. NOTE: no `attribute_exists(PK)` — the upsert must be able to
    // CREATE the row for a virtual occurrence, and `attribute_not_exists(activeStepId)` is satisfied
    // by a nonexistent item.
    const guard = activePointerGuard(existing ?? {});

    const accum = plan?.stepTxItem
      ? ', activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta'
      : '';
    // Upsert: create the exception row if it doesn't exist, or flip a non-terminal one to CANCELLED.
    // REMOVE clears any startedAt/completedAt/skippedAt and the active-step pointer so no stale
    // lifecycle timestamp or running timer survives the transition.
    const updateExpression =
      'SET #status = :cancelled, isException = :true, cancelledAt = :now, updatedAt = :now, ' +
      'entityType = :entityType, instanceId = :instanceId, assignmentId = :assignmentId, ' +
      'taskId = :taskId, userId = :userId, scheduledDate = :scheduledDate, ' +
      'scheduledTime = :scheduledTime, scheduledFor = :scheduledFor, #tz = :timezone, ' +
      `createdAt = if_not_exists(createdAt, :now)${accum} ` +
      'REMOVE completedAt, skippedAt, activeStepId, activeStepStartedAt';
    const values: Record<string, unknown> = {
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
      ...guard.values,
    };
    if (plan?.stepTxItem) {
      values[':zero'] = 0;
      values[':delta'] = delta;
    }
    const instanceUpdate = {
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: instanceSk },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { '#status': 'status', '#tz': 'timezone' },
      ExpressionAttributeValues: values,
      ConditionExpression: guard.condition,
    };

    try {
      // No running step to close: a single upsert. Otherwise close the step in the same transaction.
      if (!plan?.stepTxItem) {
        const result = await dynamo.send(
          new UpdateCommand({ ...instanceUpdate, ReturnValues: 'ALL_NEW' }),
        );
        return presentInstance(result.Attributes as Record<string, unknown>);
      }
      await dynamo.send(
        new TransactWriteCommand({ TransactItems: [{ Update: instanceUpdate }, plan.stepTxItem] }),
      );
    } catch (err) {
      if (isOptimisticConflict(err) && attempt < MAX_TIMING_RETRIES) continue;
      throw err;
    }

    const merged: Record<string, unknown> = {
      ...(existing ?? {}),
      status: 'CANCELLED',
      isException: true,
      cancelledAt: now,
      instanceId,
      activeDurationSeconds: numberOr(existing?.activeDurationSeconds, 0) + delta,
      updatedAt: now,
    };
    delete merged.completedAt;
    delete merged.skippedAt;
    delete merged.activeStepId;
    delete merged.activeStepStartedAt;
    return presentInstance(merged);
  }
}

// ── endTaskAssignment ───────────────────────────────────────────────────────--

/**
 * End an assignment from `effectiveDate` onward. For a RECURRING assignment that still has
 * occurrence days before then, caps `endDate` to the day before (and keeps it active so prior
 * occurrences still surface). Otherwise the assignment is fully ended: active=false, endedAt
 * set, and the activeTaskAssignmentTaskId marker removed (unblocking task deletion).
 */
async function endTaskAssignment(
  input: EndTaskAssignmentInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskAssignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  const effectiveDate = input?.effectiveDate?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  if (!effectiveDate) throw new ValidationError('effectiveDate is required and cannot be empty');
  const eff = DateTime.fromFormat(effectiveDate, 'yyyy-MM-dd', { zone: 'utc' });
  if (!eff.isValid) throw new ValidationError('effectiveDate must be a valid YYYY-MM-DD date');
  await assertCanActForUser(identity, userId);

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
async function deleteTaskAssignment(
  input: DeleteTaskAssignmentInput,
  identity: AppSyncIdentity | undefined,
): Promise<TaskAssignment> {
  const userId = input?.userId?.trim();
  const assignmentId = input?.assignmentId?.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  if (!assignmentId) throw new ValidationError('assignmentId is required and cannot be empty');
  await assertCanActForUser(identity, userId);

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
  identity: AppSyncIdentity | undefined,
): Promise<Connection<TaskAssignment>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  await assertCanActForUser(identity, userId.trim());
  const result = await queryPage<Record<string, unknown>>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': userPk(userId.trim()),
        ':prefix': TASK_ASSIGNMENT_PREFIX,
      },
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
  identity: AppSyncIdentity | undefined,
): Promise<Connection<TaskInstanceView>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  const id = userId.trim();
  await assertCanActForUser(identity, id);
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
      const instanceId = taskInstanceId(
        assignment.assignmentId,
        occ.scheduledDate,
        occ.scheduledTime,
      );
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
    const title =
      titles.get(inst.taskId) ??
      titles.get(assignmentById.get(inst.assignmentId)?.taskId ?? '') ??
      '';
    views.push(viewFromInstance(inst, title, nowMs));
  }

  views.sort((a, b) =>
    a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : 0,
  );
  return { items: views, nextToken: null };
}

/**
 * getTaskInstance — read ONE materialized TaskInstance by instanceId. Omitted `requestedUserId`
 * preserves the original self-scoped behavior; a supplied non-self id requires effective
 * SupportPerson delegation. Returns null when the instance doesn't exist for the resolved user.
 * `status` is derived like getTaskInstanceViews.
 */
async function getTaskInstance(
  identity: AppSyncIdentity | undefined,
  instanceId: string,
  requestedUserId?: string | null,
): Promise<TaskInstance | null> {
  const userId = await resolveTaskInstanceReadUser(identity, requestedUserId);
  const id = instanceId?.trim();
  if (!id) throw new ValidationError('instanceId is required and cannot be empty');
  const parsed = parseInstanceId(id);
  if (!parsed) throw new ValidationError(`invalid instanceId "${id}"`);

  const item = await getInstance(
    userId,
    parsed.scheduledDate,
    parsed.scheduledTime,
    parsed.assignmentId,
  );
  if (!item) return null;
  return presentInstanceRead(item, Date.now());
}

/**
 * listTaskInstances — one resolved user's real/materialized TaskInstances whose scheduledDate
 * falls in [startDate, endDate]. Omitted `requestedUserId` preserves self-scoped reads; a supplied
 * non-self id requires effective SupportPerson delegation. Unlike getTaskInstanceViews this
 * returns ONLY rows that exist in DynamoDB — it never synthesizes virtual occurrences — and is
 * truly paginated via the opaque nextToken. `status` is derived (a past-due non-terminal instance
 * surfaces as OVERDUE; the stored row is never rewritten).
 */
async function listTaskInstances(
  identity: AppSyncIdentity | undefined,
  startDate: string,
  endDate: string,
  page: PageArgs,
  requestedUserId?: string | null,
): Promise<Connection<TaskInstance>> {
  const userId = await resolveTaskInstanceReadUser(identity, requestedUserId);
  const { start, end } = validateDateRange(startDate, endDate);

  // Date-sorted SK ⇒ one BETWEEN scopes the USER#<userId> partition to instance rows in the
  // window; the TASK_INSTANCE#…#￿ upper bound stays below TASK_INSTANCE_STEP# so step rows never leak in.
  const result = await queryPage<Record<string, unknown>>(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
      ExpressionAttributeValues: {
        ':pk': userPk(userId),
        ':lo': `${TASK_INSTANCE_PREFIX}${start}`,
        ':hi': `${TASK_INSTANCE_PREFIX}${end}#￿`,
      },
    },
    page,
  );
  const nowMs = Date.now();
  return {
    items: result.items.map((item) => presentInstanceRead(item, nowMs)),
    nextToken: result.nextToken,
  };
}

/**
 * batchGetTaskInstances — read up to 100 of one resolved user's materialized TaskInstances by id
 * in one shot. Omitted `requestedUserId` preserves self-scoped reads; a supplied non-self id
 * requires effective SupportPerson delegation. Returns one result per requested id, in the SAME
 * order, with `item: null` for ids that don't exist for the resolved user. Invalid ids are rejected
 * before instance IO. `status` is derived (OVERDUE surfaced).
 */
async function batchGetTaskInstances(
  identity: AppSyncIdentity | undefined,
  instanceIds: string[],
  requestedUserId?: string | null,
): Promise<TaskInstanceLookupResult[]> {
  const userId = await resolveTaskInstanceReadUser(identity, requestedUserId);
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    throw new ValidationError('instanceIds is required and cannot be empty');
  }
  if (instanceIds.length > MAX_BATCH_GET_INSTANCES) {
    throw new ValidationError(`instanceIds may contain at most ${MAX_BATCH_GET_INSTANCES} ids`);
  }

  // Validate every id up front and map it to its SK (the id↔SK mapping is a bijection). Fetch
  // only the unique SKs — duplicate ids in the request resolve from the same fetched row.
  const requested = instanceIds.map((raw) => {
    const id = raw?.trim();
    if (!id) throw new ValidationError('instanceId is required and cannot be empty');
    const sk = taskInstanceSkFromId(id);
    if (!sk) throw new ValidationError(`invalid instanceId "${id}"`);
    return { id, sk };
  });

  const bySk = await batchGetInstances(userId, [...new Set(requested.map((r) => r.sk))]);

  const nowMs = Date.now();
  return requested.map(({ id, sk }) => {
    const item = bySk.get(sk);
    return { instanceId: id, item: item ? presentInstanceRead(item, nowMs) : null };
  });
}

/**
 * Resolve the USER# partition for a materialized-instance read. Keeping userId optional is
 * backward-compatible with the original self-only API: omitted/null always means the caller.
 * An explicitly supplied id (including the caller's own id) goes through the shared delegation
 * predicate, whose self path is read-free and whose non-self path fails closed unless the
 * SupportPerson relationship is currently effective.
 */
async function resolveTaskInstanceReadUser(
  identity: AppSyncIdentity | undefined,
  requestedUserId?: string | null,
): Promise<string> {
  if (requestedUserId == null) return requireCaller(identity);
  const userId = requestedUserId.trim();
  if (!userId) throw new ValidationError('userId is required and cannot be empty');
  await assertCanActForUser(identity, userId);
  return userId;
}

async function listTaskInstanceSteps(
  userId: string,
  instanceId: string,
  page: PageArgs,
  identity: AppSyncIdentity | undefined,
): Promise<Connection<TaskInstanceStep>> {
  if (!userId?.trim()) throw new ValidationError('userId is required');
  if (!instanceId?.trim()) throw new ValidationError('instanceId is required');
  await assertCanActForUser(identity, userId.trim());

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
    .map((s) => presentStep(s as unknown as Record<string, unknown>))
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

/**
 * BatchGet the caller's TaskInstance rows for the given SKs, keyed by SK (missing rows are simply
 * absent from the map). Chunks at DynamoDB's 100-key BatchGet ceiling and retries throttling-driven
 * UnprocessedKeys under a bounded budget, mirroring batchDelete/batchPut in the shared batch helper.
 */
async function batchGetInstances(
  userId: string,
  sks: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < sks.length; i += MAX_BATCH_GET_INSTANCES) {
    let keys: Record<string, unknown>[] = sks
      .slice(i, i + MAX_BATCH_GET_INSTANCES)
      .map((sk) => ({ PK: userPk(userId), SK: sk }));
    // Bounded retry for throttling-driven UnprocessedKeys (no infinite loop).
    for (let attempt = 0; attempt < 8 && keys.length; attempt++) {
      const result = await dynamo.send(
        new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: keys } } }),
      );
      for (const item of (result.Responses?.[TABLE_NAME] as Record<string, unknown>[]) ?? []) {
        found.set(item.SK as string, item);
      }
      keys = (result.UnprocessedKeys?.[TABLE_NAME]?.Keys as Record<string, unknown>[]) ?? [];
    }
    if (keys.length) {
      throw new Error(
        `batchGetTaskInstances: ${keys.length} key(s) still unprocessed after retries`,
      );
    }
  }
  return found;
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

/** Read one TaskInstanceStep snapshot by (instanceId, stepId), or undefined if absent. */
async function loadInstanceStep(
  userId: string,
  instanceId: string,
  stepId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskInstanceStepSk(instanceId, stepId) },
    }),
  );
  return result.Item as Record<string, unknown> | undefined;
}

// ── Active-step timing helpers ────────────────────────────────────────────────
/**
 * Whole seconds between two server ISO instants, floored and clamped to ≥ 0. Both endpoints are
 * server-generated (`new Date().toISOString()`); a malformed value yields 0 rather than NaN.
 */
function elapsedSecondsBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/** Coerce a stored value to a finite number, falling back (used to default legacy nulls to 0). */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * TransactWrite Update item that closes a running step: add its running interval (`delta`) to the
 * step's accumulated `activeDurationSeconds`. `if_not_exists` defaults a legacy row missing the
 * field to 0 before adding.
 */
function closeStepTxItem(
  userId: string,
  instanceId: string,
  stepId: string,
  delta: number,
  now: string,
) {
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: taskInstanceStepSk(instanceId, stepId) },
      UpdateExpression:
        'SET activeDurationSeconds = if_not_exists(activeDurationSeconds, :zero) + :delta, updatedAt = :now',
      ExpressionAttributeValues: { ':zero': 0, ':delta': delta, ':now': now },
      ConditionExpression: 'attribute_exists(PK)',
    },
  };
}

interface ActiveStepClosePlan {
  /** Seconds to add to BOTH the step and the instance (0 when the pointer is stale). */
  delta: number;
  /** The active step's id (the pointer being closed). */
  activeStepId: string;
  /** The step's TransactWrite Update item, or null when its snapshot is missing (nothing to add). */
  stepTxItem: ReturnType<typeof closeStepTxItem> | null;
}

/**
 * Plan how to close an instance's currently-running step. `activeStepRow` is the already-loaded
 * step snapshot (undefined when the pointer is stale/corrupt or when there is no startedAt to load
 * against). Returns null only when there is no active pointer at all.
 *
 * A pointer that can't be counted — no `activeStepStartedAt` (corrupt partial pointer) or a missing
 * step snapshot (stale pointer) — still yields a plan with `delta 0` and no step write, so the
 * pointer is CLEARED without counting. This keeps the instance's `activeDurationSeconds` equal to
 * the sum of its steps' (no silent divergence, no transaction-condition failure on a nonexistent
 * row) and self-heals a corrupt pointer. Every close path uses this for identical handling.
 */
function planActiveStepClose(
  userId: string,
  instanceId: string,
  instance: Record<string, unknown>,
  activeStepRow: Record<string, unknown> | undefined,
  now: string,
): ActiveStepClosePlan | null {
  const activeStepId = instance.activeStepId as string | undefined;
  if (!activeStepId) return null;
  const startedAt = instance.activeStepStartedAt as string | undefined;
  // Corrupt (no startedAt) or stale (snapshot gone): clear the pointer, count nothing.
  if (!startedAt || !activeStepRow) return { delta: 0, activeStepId, stepTxItem: null };
  const delta = elapsedSecondsBetween(startedAt, now);
  return {
    delta,
    activeStepId,
    stepTxItem: closeStepTxItem(userId, instanceId, activeStepId, delta, now),
  };
}

/** True for the DynamoDB errors a lost optimistic-concurrency (active-pointer) race surfaces as. */
function isOptimisticConflict(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

/**
 * Optimistic-concurrency guard for the instance write in an active-step close path: the write only
 * lands if the active pointer is still EXACTLY what we read (same step + same start, or still
 * absent). This prevents two overlapping close paths (e.g. pause racing setTaskInstanceStepCompletion)
 * from both reading the same pointer and both counting the same interval. Returns the condition
 * fragment to AND onto `attribute_exists(PK)` plus the expected-value bindings to merge in.
 */
function activePointerGuard(instance: Record<string, unknown>): {
  condition: string;
  values: Record<string, unknown>;
} {
  const activeStepId = instance.activeStepId as string | undefined;
  const startedAt = instance.activeStepStartedAt as string | undefined;
  if (!activeStepId) return { condition: 'attribute_not_exists(activeStepId)', values: {} };
  if (!startedAt) {
    return {
      condition: 'activeStepId = :expActiveStepId AND attribute_not_exists(activeStepStartedAt)',
      values: { ':expActiveStepId': activeStepId },
    };
  }
  return {
    condition: 'activeStepId = :expActiveStepId AND activeStepStartedAt = :expActiveStepStartedAt',
    values: { ':expActiveStepId': activeStepId, ':expActiveStepStartedAt': startedAt },
  };
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
function viewFromInstance(inst: TaskInstance, title: string, nowMs: number): TaskInstanceView {
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
    // A stored row's status is always persisted (never the derived OVERDUE).
    status: deriveInstanceStatus(
      inst.status as PersistedTaskInstanceStatus,
      inst.scheduledFor,
      nowMs,
    ),
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

/**
 * Project a stored TaskInstance row into the API shape (storage attributes stripped).
 * `activeDurationSeconds` is defaulted to 0 so a legacy row missing it never violates the
 * GraphQL `Int!` contract.
 */
function presentInstance(item: Record<string, unknown>): TaskInstance {
  const out = stripStorage(item);
  out.activeDurationSeconds = numberOr(out.activeDurationSeconds, 0);
  return out as unknown as TaskInstance;
}

/**
 * Project a stored TaskInstanceStep row into the API shape (storage attributes stripped).
 * `activeDurationSeconds` is defaulted to 0 for legacy snapshots (GraphQL `Int!`).
 */
function presentStep(item: Record<string, unknown>): TaskInstanceStep {
  const out = stripStorage(item);
  out.activeDurationSeconds = numberOr(out.activeDurationSeconds, 0);
  return out as unknown as TaskInstanceStep;
}

/**
 * Project a stored TaskInstance row for the read APIs (getTaskInstance/listTaskInstances/
 * batchGetTaskInstances): strip storage attributes AND derive `status` the same way
 * getTaskInstanceViews does — a past-due non-terminal instance surfaces as OVERDUE, terminal
 * statuses pass through unchanged. OVERDUE is never written back to DynamoDB.
 */
function presentInstanceRead(item: Record<string, unknown>, nowMs: number): TaskInstance {
  const instance = presentInstance(item);
  // A stored row's status is always persisted; deriveInstanceStatus may widen it to OVERDUE,
  // which TaskInstance.status (TaskInstanceStatus) now permits — no cast on the result needed.
  const status = deriveInstanceStatus(
    instance.status as PersistedTaskInstanceStatus,
    instance.scheduledFor,
    nowMs,
  );
  return { ...instance, status };
}
