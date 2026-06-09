import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TASKS_TABLE } from '../../shared/dynamodb';
import { ValidationError } from '../../shared/response';
import type { AppSyncEvent, CreateTaskInput, Task } from '../../shared/types';

export const handler = async (event: AppSyncEvent<{ input: CreateTaskInput }>): Promise<Task> => {
  const { input } = event.arguments;

  if (!input?.title?.trim()) {
    throw new ValidationError('title is required and cannot be empty');
  }

  const task: Task = {
    taskId: randomUUID(),
    title: input.title.trim(),
    description: input.description?.trim(),
    createdAt: new Date().toISOString(),
  };

  await dynamo.send(
    new PutCommand({
      TableName: TASKS_TABLE,
      Item: task,
    }),
  );

  return task;
};
