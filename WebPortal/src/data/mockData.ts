/**
 * Mock data for the CanPlan 2.0 Supporter Portal.
 *
 * This module is the ONLY place raw fake data lives. Components must never
 * import from here directly — they go through `src/api/fakeGraphqlClient.ts`,
 * which mimics async GraphQL behavior. When the real AppSync backend is
 * wired up, this file can be deleted and the API layer reimplemented.
 */

import type {
  Assignment,
  ProgressEvent,
  Task,
  UserProfile,
} from '../types';

export const mockUsers: UserProfile[] = [
  {
    id: 'user-1',
    fullName: 'Avery Johnson',
    email: 'avery.johnson@example.com',
    lastActiveAt: '2026-06-09T08:15:00Z',
    status: 'active',
  },
  {
    id: 'user-2',
    fullName: 'Bao Nguyen',
    email: 'bao.nguyen@example.com',
    lastActiveAt: '2026-06-08T19:42:00Z',
    status: 'active',
  },
  {
    id: 'user-3',
    fullName: 'Carmen Diaz',
    email: 'carmen.diaz@example.com',
    lastActiveAt: '2026-06-09T07:05:00Z',
    status: 'active',
  },
  {
    id: 'user-4',
    fullName: 'Devon Smith',
    email: 'devon.smith@example.com',
    lastActiveAt: '2026-06-05T14:30:00Z',
    status: 'inactive',
  },
  {
    id: 'user-5',
    fullName: 'Elif Kaya',
    email: 'elif.kaya@example.com',
    lastActiveAt: '2026-06-09T06:50:00Z',
    status: 'active',
  },
];

export const mockTasks: Task[] = [
  {
    id: 'task-1',
    title: 'Morning routine',
    description: 'Complete the morning self-care checklist.',
    status: 'in_progress',
    assignedUserId: 'user-1',
    createdAt: '2026-06-01T09:00:00Z',
    updatedAt: '2026-06-09T08:10:00Z',
    dueDate: '2026-06-09T12:00:00Z',
    steps: [
      { id: 'step-1-1', title: 'Brush teeth', completed: true, order: 1 },
      { id: 'step-1-2', title: 'Take medication', completed: true, order: 2 },
      { id: 'step-1-3', title: 'Eat breakfast', completed: false, order: 3 },
    ],
  },
  {
    id: 'task-2',
    title: 'Grocery shopping',
    description: 'Buy items from the weekly grocery list.',
    status: 'not_started',
    assignedUserId: 'user-2',
    createdAt: '2026-06-07T10:00:00Z',
    updatedAt: '2026-06-07T10:00:00Z',
    dueDate: '2026-06-10T17:00:00Z',
    steps: [
      { id: 'step-2-1', title: 'Make a list', completed: false, order: 1 },
      { id: 'step-2-2', title: 'Travel to store', completed: false, order: 2 },
      { id: 'step-2-3', title: 'Check out', completed: false, order: 3 },
    ],
  },
  {
    id: 'task-3',
    title: 'Bus to community center',
    description: 'Take the number 12 bus to the Tuesday group session.',
    status: 'completed',
    assignedUserId: 'user-3',
    createdAt: '2026-06-03T08:00:00Z',
    updatedAt: '2026-06-08T16:20:00Z',
    steps: [
      { id: 'step-3-1', title: 'Walk to bus stop', completed: true, order: 1 },
      { id: 'step-3-2', title: 'Board the bus', completed: true, order: 2 },
      { id: 'step-3-3', title: 'Get off at Main St', completed: true, order: 3 },
    ],
  },
  {
    id: 'task-4',
    title: 'Laundry',
    description: 'Wash, dry, and fold a load of laundry.',
    status: 'in_progress',
    assignedUserId: 'user-5',
    createdAt: '2026-06-06T11:00:00Z',
    updatedAt: '2026-06-09T06:45:00Z',
    steps: [
      { id: 'step-4-1', title: 'Sort clothes', completed: true, order: 1 },
      { id: 'step-4-2', title: 'Start washer', completed: true, order: 2 },
      { id: 'step-4-3', title: 'Move to dryer', completed: false, order: 3 },
      { id: 'step-4-4', title: 'Fold and put away', completed: false, order: 4 },
    ],
  },
  {
    id: 'task-5',
    title: 'Prepare lunch',
    description: 'Make a simple sandwich and clean up.',
    status: 'completed',
    assignedUserId: 'user-1',
    createdAt: '2026-06-08T11:30:00Z',
    updatedAt: '2026-06-08T12:15:00Z',
    steps: [
      { id: 'step-5-1', title: 'Gather ingredients', completed: true, order: 1 },
      { id: 'step-5-2', title: 'Assemble sandwich', completed: true, order: 2 },
      { id: 'step-5-3', title: 'Clean counter', completed: true, order: 3 },
    ],
  },
];

/** The currently signed-in supporter (mocked, no real auth yet). */
export const currentSupporterId = 'supporter-1';

export const mockAssignments: Assignment[] = [
  {
    id: 'assign-1',
    supporterId: currentSupporterId,
    userId: 'user-1',
    assignedAt: '2026-05-01T09:00:00Z',
    role: 'supporter',
  },
  {
    id: 'assign-2',
    supporterId: currentSupporterId,
    userId: 'user-2',
    assignedAt: '2026-05-01T09:00:00Z',
    role: 'supporter',
  },
  {
    id: 'assign-3',
    supporterId: currentSupporterId,
    userId: 'user-3',
    assignedAt: '2026-05-10T09:00:00Z',
    role: 'supporter',
  },
  {
    id: 'assign-4',
    supporterId: currentSupporterId,
    userId: 'user-4',
    assignedAt: '2026-05-12T09:00:00Z',
    role: 'admin',
  },
  {
    id: 'assign-5',
    supporterId: currentSupporterId,
    userId: 'user-5',
    assignedAt: '2026-05-20T09:00:00Z',
    role: 'supporter',
  },
];

export const mockProgressEvents: ProgressEvent[] = [
  {
    id: 'event-1',
    type: 'help_requested',
    userId: 'user-2',
    taskId: 'task-2',
    message: 'Bao Nguyen requested help with "Grocery shopping".',
    occurredAt: '2026-06-09T08:30:00Z',
  },
  {
    id: 'event-2',
    type: 'step_completed',
    userId: 'user-1',
    taskId: 'task-1',
    message: 'Avery Johnson completed step "Take medication".',
    occurredAt: '2026-06-09T08:12:00Z',
  },
  {
    id: 'event-3',
    type: 'task_completed',
    userId: 'user-3',
    taskId: 'task-3',
    message: 'Carmen Diaz completed "Bus to community center".',
    occurredAt: '2026-06-08T16:20:00Z',
  },
  {
    id: 'event-4',
    type: 'task_started',
    userId: 'user-5',
    taskId: 'task-4',
    message: 'Elif Kaya started "Laundry".',
    occurredAt: '2026-06-09T06:40:00Z',
  },
  {
    id: 'event-5',
    type: 'help_requested',
    userId: 'user-5',
    taskId: 'task-4',
    message: 'Elif Kaya requested help with "Laundry".',
    occurredAt: '2026-06-09T06:55:00Z',
  },
  {
    id: 'event-6',
    type: 'task_completed',
    userId: 'user-1',
    taskId: 'task-5',
    message: 'Avery Johnson completed "Prepare lunch".',
    occurredAt: '2026-06-08T12:15:00Z',
  },
];
