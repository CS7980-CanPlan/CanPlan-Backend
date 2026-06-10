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

// AI assistant: a single prompt in, a single model response out
export interface AskAiInput {
  prompt: string;
}

export interface AiResponse {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
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
