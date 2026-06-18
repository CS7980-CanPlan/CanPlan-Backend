// Schedule normalization shared by createTask and updateTask so both enforce the
// same rules. Phase 1 only validates + stores this metadata — reminder delivery
// (EventBridge / push) is not implemented yet.

import { ValidationError } from './response';
import type { TaskSchedule, TaskScheduleInput } from './types';

/**
 * Validate a schedule input and return its stored form (with `enabled` defaulted to
 * true) plus the derived `nextOccurrenceAt` (= firstOccurrenceAt). Returns `{}` when
 * no schedule is supplied. Throws ValidationError on invalid input.
 */
export function normalizeSchedule(raw?: TaskScheduleInput | null): {
  schedule?: TaskSchedule;
  nextOccurrenceAt?: string;
} {
  if (!raw) return {};

  if (!Number.isInteger(raw.repeatEvery) || raw.repeatEvery < 1) {
    throw new ValidationError('schedule.repeatEvery must be a positive integer');
  }
  if (!raw.repeatUnit) {
    throw new ValidationError('schedule.repeatUnit is required');
  }
  if (!raw.firstOccurrenceAt?.trim()) {
    throw new ValidationError('schedule.firstOccurrenceAt is required and cannot be empty');
  }
  if (!raw.timezone?.trim()) {
    throw new ValidationError('schedule.timezone is required and cannot be empty');
  }

  const schedule: TaskSchedule = {
    repeatEvery: raw.repeatEvery,
    repeatUnit: raw.repeatUnit,
    firstOccurrenceAt: raw.firstOccurrenceAt.trim(),
    timezone: raw.timezone.trim(),
    enabled: raw.enabled ?? true,
  };
  return { schedule, nextOccurrenceAt: schedule.firstOccurrenceAt };
}
