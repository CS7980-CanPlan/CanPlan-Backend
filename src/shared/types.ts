// Core domain types shared across Lambda functions

export interface Task {
  taskId: string;
  title: string;
  description?: string;
  createdAt: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
}

// Shape of the AppSync event passed to Lambda resolvers
export interface AppSyncEvent<TArgs = Record<string, unknown>> {
  arguments: TArgs;
  identity?: unknown;
  source?: unknown;
  request?: {
    headers: Record<string, string>;
  };
}
