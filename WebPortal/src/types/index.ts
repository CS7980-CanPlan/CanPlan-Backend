/**
 * Domain types for the CanPlan 2.0 Supporter Portal.
 *
 * These mirror the shapes we expect to receive from the future AWS AppSync
 * GraphQL backend. They are intentionally backend-agnostic so the fake API
 * layer (see `src/api/fakeGraphqlClient.ts`) can be swapped for real
 * AppSync queries without changing component code.
 */

/** A person who uses CanPlan and is supported through the portal. */
export interface UserProfile {
  id: string;
  fullName: string;
  email: string;
  /** Optional avatar URL; portal falls back to initials when absent. */
  avatarUrl?: string;
  /** ISO-8601 timestamp of the user's most recent app activity. */
  lastActiveAt: string;
  status: 'active' | 'inactive';
}

/** A single step within a Task. Tasks in CanPlan are broken into steps. */
export interface TaskStep {
  id: string;
  title: string;
  completed: boolean;
  /** Optional position used to order steps within a task. */
  order: number;
}

export type TaskStatus = 'not_started' | 'in_progress' | 'completed';

/** A task assigned to a CanPlan user, composed of ordered steps. */
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** ID of the UserProfile this task belongs to. */
  assignedUserId: string;
  steps: TaskStep[];
  /** ISO-8601 due date, if the task has one. */
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

/** Links a supporter/admin to a user they are responsible for. */
export interface Assignment {
  id: string;
  /** ID of the supporter or admin who owns this assignment. */
  supporterId: string;
  /** ID of the supported UserProfile. */
  userId: string;
  assignedAt: string;
  role: 'supporter' | 'admin';
}

export type ProgressEventType =
  | 'task_started'
  | 'task_completed'
  | 'step_completed'
  | 'help_requested';

/** A timeline entry describing something a user did or needs help with. */
export interface ProgressEvent {
  id: string;
  type: ProgressEventType;
  userId: string;
  /** ID of the related task, when the event is task-related. */
  taskId?: string;
  /** Human-readable summary shown in the activity feed. */
  message: string;
  /** ISO-8601 timestamp of when the event occurred. */
  occurredAt: string;
}

/** Aggregated counts powering the dashboard summary cards. */
export interface DashboardSummary {
  assignedUsers: number;
  activeTasks: number;
  completedTasks: number;
  helpRequests: number;
}
