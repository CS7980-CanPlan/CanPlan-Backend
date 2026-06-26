/**
 * Fake GraphQL client for the CanPlan 2.0 Supporter Portal.
 *
 * This module simulates the shape of an AWS AppSync GraphQL data source using
 * in-memory mock data and artificial network latency. Components consume only
 * these async functions — they never import the mock data directly.
 *
 * REPLACING THIS LATER:
 * Swap the bodies of these functions for real AppSync GraphQL requests
 * authenticated with the signed-in Cognito user's ID token. As long as the
 * function signatures and return types stay the same, no component code needs to
 * change.
 */

import {
  currentSupporterId,
  mockAssignments,
  mockProgressEvents,
  mockTasks,
  mockUsers,
} from '../data/mockData';
import type {
  DashboardSummary,
  ProgressEvent,
  Task,
  UserProfile,
} from '../types';

/** Simulated network latency in milliseconds. */
const FAKE_LATENCY_MS = 350;

/**
 * Resolves with a deep-ish copy of `data` after a short delay, mimicking an
 * async network round-trip. Returning a copy prevents callers from mutating
 * the shared mock data set.
 */
function simulateRequest<T>(data: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(structuredClone(data));
    }, FAKE_LATENCY_MS);
  });
}

/** IDs of users assigned to the current supporter. */
function assignedUserIds(): Set<string> {
  return new Set(
    mockAssignments
      .filter((assignment) => assignment.supporterId === currentSupporterId)
      .map((assignment) => assignment.userId),
  );
}

/** Returns the aggregated counts for the dashboard summary cards. */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const userIds = assignedUserIds();
  const tasks = mockTasks.filter((task) => userIds.has(task.assignedUserId));

  const summary: DashboardSummary = {
    assignedUsers: userIds.size,
    activeTasks: tasks.filter(
      (task) => task.status === 'in_progress' || task.status === 'not_started',
    ).length,
    completedTasks: tasks.filter((task) => task.status === 'completed').length,
    helpRequests: mockProgressEvents.filter(
      (event) =>
        event.type === 'help_requested' && userIds.has(event.userId),
    ).length,
  };

  return simulateRequest(summary);
}

/** Returns the users assigned to the current supporter, sorted by name. */
export async function getAssignedUsers(): Promise<UserProfile[]> {
  const userIds = assignedUserIds();
  const users = mockUsers
    .filter((user) => userIds.has(user.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return simulateRequest(users);
}

/**
 * Returns the most recent progress events for assigned users, newest first.
 *
 * @param limit Maximum number of events to return (default 5).
 */
export async function getRecentActivity(limit = 5): Promise<ProgressEvent[]> {
  const userIds = assignedUserIds();
  const events = mockProgressEvents
    .filter((event) => userIds.has(event.userId))
    .sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    )
    .slice(0, limit);

  return simulateRequest(events);
}

/** Returns all tasks for the current supporter's assigned users. */
export async function getTasks(): Promise<Task[]> {
  const userIds = assignedUserIds();
  const tasks = mockTasks.filter((task) => userIds.has(task.assignedUserId));

  return simulateRequest(tasks);
}
