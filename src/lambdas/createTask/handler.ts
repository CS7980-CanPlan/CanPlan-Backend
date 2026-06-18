import { randomUUID } from 'crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from '../../shared/dynamodb';
import { ENTITY, META_SK, NO_CATEGORY, stepSk, taskCategoryKey, taskPk } from '../../shared/keys';
import { ValidationError } from '../../shared/response';
import { normalizeSchedule } from '../../shared/schedule';
import type { AppSyncEvent, CreateTaskInput, Task, TaskStep } from '../../shared/types';

/**
 * createTask — create a reusable task template owned by a SupportPerson or
 * OrgAdmin. Writes one Task `#META` item plus one TaskStep item per nested step,
 * each as a separate row (never an embedded array). Task and step writes happen
 * in a single transaction so a task never lands without its steps.
 *
 * Assignment creation is a separate operation (createAssignment) — not done here.
 */
export const handler = async (event: AppSyncEvent<{ input: CreateTaskInput }>): Promise<Task> => {
  const { input } = event.arguments;

  if (!input?.ownerId?.trim()) {
    throw new ValidationError('ownerId is required and cannot be empty');
  }
  if (!input?.title?.trim()) {
    throw new ValidationError('title is required and cannot be empty');
  }

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const ownerId = input.ownerId.trim();
  // Blank/omitted category collapses to the reserved NO_CATEGORY bucket so every
  // Task has a queryable taskCategoryKey (no missing-attribute special case).
  const categoryId = input.categoryId?.trim() || NO_CATEGORY;

  const { schedule, nextOccurrenceAt } = normalizeSchedule(input.schedule);

  const task: Task = {
    taskId,
    ownerId,
    title: input.title.trim(),
    categoryId,
    taskCategoryKey: taskCategoryKey(ownerId, categoryId),
    description: input.description?.trim(),
    scheduleRule: input.scheduleRule?.trim(),
    status: input.status ?? 'DRAFT',
    schedule,
    nextOccurrenceAt,
    // Default to enabled alongside a schedule; otherwise leave whatever the client sent
    // (undefined is dropped by the document client's removeUndefinedValues).
    notificationEnabled: schedule ? (input.notificationEnabled ?? true) : input.notificationEnabled,
    createdAt: now,
    updatedAt: now,
  };

  // Each nested step becomes its own TaskStep item with a 1-based, zero-padded order.
  const steps: TaskStep[] = (input.steps ?? []).map((step, index) => {
    if (!step?.text?.trim()) {
      throw new ValidationError(`step ${index + 1}: text is required and cannot be empty`);
    }
    return {
      stepId: randomUUID(),
      taskId,
      order: index + 1,
      text: step.text.trim(),
      mediaRefs: step.mediaRefs,
      expectedDuration: step.expectedDuration,
      createdAt: now,
      updatedAt: now,
    };
  });

  await dynamo.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: { PK: taskPk(taskId), SK: META_SK, entityType: ENTITY.TASK, ...task },
          },
        },
        ...steps.map((step) => ({
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: taskPk(taskId),
              SK: stepSk(step.order),
              entityType: ENTITY.TASK_STEP,
              ...step,
            },
          },
        })),
      ],
    }),
  );

  // Return the created task with the steps it just wrote (clients can also fetch
  // them later via the listTaskSteps query).
  return { ...task, steps };
};
