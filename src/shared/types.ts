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

// Step generation: a task query in, ordered source-cited steps out
export interface QueryContext {
  role?: string;
  organizationId?: string;
}

export interface GenerateTaskStepsInput {
  userId: string;
  query: string;
  context?: QueryContext;
}

export interface Citation {
  chunkId: string;
  title: string;
  url?: string;
  snippet?: string;
}

export interface TaskStep {
  text: string;
  citations: Citation[];
}

export interface TaskStepsResponse {
  steps: TaskStep[];
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

// A passage returned by KB.Retrieve, normalized for prompt-building + citation resolution
export interface RetrievedPassage {
  chunkId: string;
  text: string;
  title: string;
  url?: string;
}
