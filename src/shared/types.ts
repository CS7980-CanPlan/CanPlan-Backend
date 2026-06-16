// Core domain types shared across Lambda functions.
//
// Entity interfaces mirror the GraphQL output types (domain fields only — the
// PK/SK/entityType key attributes are added at write time, see src/shared/keys.ts).

// ── Enums (mirror graphql/schema.graphql) ─────────────────────────────────────
export type UserRole = 'PRIMARY_USER' | 'SUPPORT_PERSON' | 'ORG_ADMIN';
export type SupportLinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';
export type TaskStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type AssignmentStatus = 'ACTIVE' | 'COMPLETED' | 'PAUSED' | 'CANCELLED';
export type ProgressEventType = 'STARTED' | 'PAUSED' | 'RESUMED' | 'SKIPPED' | 'COMPLETED' | 'SYNCED';
export type MediaType = 'IMAGE' | 'AUDIO' | 'VIDEO';

// ── Entities ──────────────────────────────────────────────────────────────────
export interface UserProfile {
  userId: string;
  role: UserRole;
  displayName?: string;
  email?: string;
  organizationId?: string;
  accessibilitySettings?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface SupportLink {
  supporterId: string;
  primaryUserId: string;
  /** Mirror of primaryUserId — the supporterIndex sort key. */
  userId: string;
  status: SupportLinkStatus;
  permissions?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface Task {
  taskId: string;
  ownerId: string;
  title: string;
  categoryId?: string;
  description?: string;
  scheduleRule?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt?: string;
  /** Populated by createTask with the steps it just wrote; null on plain getTask. */
  steps?: TaskStep[];
}

export interface TaskStep {
  stepId: string;
  taskId: string;
  order: number;
  text: string;
  mediaRefs?: string[];
  expectedDuration?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface Assignment {
  assignmentId: string;
  taskId: string;
  userId: string;
  assignedBy?: string;
  dueDate?: string;
  recurrence?: string;
  scheduleRule?: string;
  active: boolean;
  status: AssignmentStatus;
  assignedAt: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ProgressEvent {
  eventId: string;
  assignmentId?: string;
  taskId?: string;
  userId: string;
  eventType: ProgressEventType;
  timestamp: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MediaAsset {
  assetId: string;
  taskId: string;
  stepId?: string;
  s3Key: string;
  type: MediaType;
  mimeType: string;
  ownerId: string;
  size?: number;
  createdAt: string;
  updatedAt?: string;
}

// ── Mutation inputs ───────────────────────────────────────────────────────────
export interface CreateUserProfileInput {
  userId: string;
  role: UserRole;
  displayName?: string;
  email?: string;
  organizationId?: string;
  accessibilitySettings?: Record<string, unknown>;
}

export interface CreateSupportLinkInput {
  supporterId: string;
  primaryUserId: string;
  status?: SupportLinkStatus;
  permissions?: Record<string, unknown>;
}

export interface CreateTaskStepNestedInput {
  text: string;
  mediaRefs?: string[];
  expectedDuration?: number;
}

export interface CreateTaskInput {
  ownerId: string;
  title: string;
  categoryId?: string;
  description?: string;
  scheduleRule?: string;
  status?: TaskStatus;
  steps?: CreateTaskStepNestedInput[];
}

export interface CreateTaskStepInput {
  taskId: string;
  order: number;
  text: string;
  mediaRefs?: string[];
  expectedDuration?: number;
}

export interface CreateAssignmentInput {
  taskId: string;
  userId: string;
  assignedBy?: string;
  dueDate?: string;
  recurrence?: string;
  scheduleRule?: string;
  active?: boolean;
  status?: AssignmentStatus;
}

export interface UpdateAssignmentStatusInput {
  userId: string;
  assignmentId: string;
  status: AssignmentStatus;
  active?: boolean;
}

export interface CreateProgressEventInput {
  userId: string;
  assignmentId?: string;
  taskId?: string;
  eventType: ProgressEventType;
  timestamp?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMediaAssetInput {
  taskId: string;
  stepId?: string;
  s3Key: string;
  type: MediaType;
  mimeType: string;
  ownerId: string;
  size?: number;
}

export interface CreateMediaUploadUrlInput {
  taskId: string;
  contentType: string;
  fileName?: string;
}

// Returned by createMediaUploadUrl: a presigned PUT URL the client uploads the
// binary to, plus the s3Key to pass back to createMediaAsset once the upload lands.
export interface MediaUploadTarget {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

// Cognito User Pool identity AppSync passes to a Lambda resolver. `groups` is the
// caller's Cognito groups surfaced as a top-level array; the raw claim lives under
// claims['cognito:groups'].
export interface AppSyncIdentity {
  sub?: string;
  username?: string;
  groups?: string[] | null;
  claims?: Record<string, unknown>;
  sourceIp?: string[];
}

// Shape of the AppSync event passed to Lambda resolvers. `info.fieldName` lets a
// single Lambda back several fields of one domain (routing on the resolved field).
export interface AppSyncEvent<TArgs = Record<string, unknown>> {
  arguments: TArgs;
  identity?: AppSyncIdentity;
  source?: unknown;
  info?: {
    fieldName: string;
    parentTypeName?: string;
  };
  request?: {
    headers: Record<string, string>;
  };
}

// A paginated list result (mirrors the GraphQL *Connection types). `nextToken` is an
// opaque, base64-encoded DynamoDB LastEvaluatedKey; null when there are no more pages.
export interface Connection<T> {
  items: T[];
  nextToken: string | null;
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

// An AI-generated step (Bedrock KB + RAG output) — distinct from the persisted
// TaskStep entity above; this one carries source citations, not storage metadata.
export interface GeneratedStep {
  text: string;
  citations: Citation[];
}

export interface TaskStepsResponse {
  steps: GeneratedStep[];
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
