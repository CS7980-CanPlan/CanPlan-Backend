import {
  expandOccurrences,
  MAX_RANGE_DAYS,
  normalizeSchedule,
  occurrenceFor,
  validateDateRange,
} from './recurrence';
import type { TaskAssignment } from './types';

const base: Omit<TaskAssignment, 'scheduleType'> = {
  assignmentId: 'a1',
  taskId: 't1',
  userId: 'u1',
  timezone: 'America/Toronto',
  active: true,
  assignedAt: 'x',
  createdAt: 'x',
};

const recurring = (over: Partial<TaskAssignment> = {}): TaskAssignment => ({
  ...base,
  scheduleType: 'RECURRING',
  scheduleRule: 'FREQ=DAILY;INTERVAL=1',
  startDate: '2099-03-01',
  startTime: '09:00',
  ...over,
});

describe('normalizeSchedule', () => {
  it('normalizes a ONE_TIME schedule and requires scheduledFor', () => {
    const out = normalizeSchedule({ scheduleType: 'ONE_TIME', scheduledFor: '2099-03-01T09:00:00Z', timezone: 'UTC' });
    expect(out.scheduleType).toBe('ONE_TIME');
    expect(out.scheduledFor).toContain('2099-03-01');
    expect(() => normalizeSchedule({ scheduleType: 'ONE_TIME', timezone: 'UTC' })).toThrow('scheduledFor is required');
  });

  it('normalizes a RECURRING schedule and validates its parts', () => {
    const out = normalizeSchedule({
      scheduleType: 'RECURRING',
      scheduleRule: 'FREQ=WEEKLY;BYDAY=MO',
      startDate: '2099-03-01',
      startTime: '09:00',
      timezone: 'UTC',
    });
    expect(out.scheduleRule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(() =>
      normalizeSchedule({ scheduleType: 'RECURRING', startDate: '2099-03-01', startTime: '09:00', timezone: 'UTC' }),
    ).toThrow('scheduleRule is required');
    expect(() =>
      normalizeSchedule({ scheduleType: 'RECURRING', scheduleRule: 'NONSENSE!!', startDate: '2099-03-01', startTime: '09:00', timezone: 'UTC' }),
    ).toThrow('not a valid RRULE');
  });

  it('rejects an invalid timezone and a bad endDate', () => {
    expect(() => normalizeSchedule({ scheduleType: 'ONE_TIME', scheduledFor: '2099-03-01T09:00:00Z', timezone: 'Mars/Phobos' })).toThrow('invalid timezone');
    expect(() =>
      normalizeSchedule({ scheduleType: 'RECURRING', scheduleRule: 'FREQ=DAILY', startDate: '2099-03-10', endDate: '2099-03-01', startTime: '09:00', timezone: 'UTC' }),
    ).toThrow('endDate cannot be before startDate');
  });

  it('rejects an incomplete RRULE with no FREQ', () => {
    expect(() =>
      normalizeSchedule({ scheduleType: 'RECURRING', scheduleRule: 'INTERVAL=2', startDate: '2099-03-01', startTime: '09:00', timezone: 'UTC' }),
    ).toThrow('must specify a FREQ');
  });

  it('rejects pathologically high frequencies (SECONDLY/MINUTELY/HOURLY)', () => {
    const make = (freq: string) =>
      normalizeSchedule({ scheduleType: 'RECURRING', scheduleRule: `FREQ=${freq}`, startDate: '2099-03-01', startTime: '09:00', timezone: 'UTC' });
    expect(() => make('SECONDLY')).toThrow('FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY');
    expect(() => make('MINUTELY')).toThrow('FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY');
    expect(() => make('HOURLY')).toThrow('FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY');
  });

  it('accepts the calendar-scale frequencies (DAILY/WEEKLY/MONTHLY/YEARLY)', () => {
    const make = (freq: string) =>
      normalizeSchedule({ scheduleType: 'RECURRING', scheduleRule: `FREQ=${freq}`, startDate: '2099-03-01', startTime: '09:00', timezone: 'UTC' });
    for (const freq of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']) {
      expect(make(freq).scheduleRule).toBe(`FREQ=${freq}`);
    }
  });

  it('rejects an out-of-range startTime (right shape, impossible time)', () => {
    const make = (startTime: string) =>
      normalizeSchedule({ scheduleType: 'RECURRING', scheduleRule: 'FREQ=DAILY', startDate: '2099-03-01', startTime, timezone: 'UTC' });
    expect(() => make('24:00')).toThrow('startTime must be a valid HH:mm time');
    expect(() => make('99:99')).toThrow('startTime must be a valid HH:mm time');
    expect(() => make('12:60')).toThrow('startTime must be a valid HH:mm time');
    expect(make('23:59').startTime).toBe('23:59'); // boundary is accepted
    expect(make('00:00').startTime).toBe('00:00');
  });
});

describe('validateDateRange', () => {
  it('caps the span at MAX_RANGE_DAYS', () => {
    const start = '2099-01-01';
    const end = '2100-01-06'; // 371 days
    expect(() => validateDateRange(start, end)).toThrow(`at most ${MAX_RANGE_DAYS} days`);
    expect(validateDateRange('2099-01-01', '2099-01-10')).toEqual({ start: '2099-01-01', end: '2099-01-10' });
  });
});

describe('expandOccurrences', () => {
  it('expands a daily rule across the window', () => {
    const occ = expandOccurrences(recurring(), '2099-03-01', '2099-03-03');
    expect(occ.map((o) => o.scheduledDate)).toEqual(['2099-03-01', '2099-03-02', '2099-03-03']);
    expect(occ.every((o) => o.scheduledTime === '09:00')).toBe(true);
  });

  it('clamps to the assignment startDate/endDate', () => {
    const occ = expandOccurrences(recurring({ endDate: '2099-03-02' }), '2099-02-01', '2099-03-31');
    expect(occ.map((o) => o.scheduledDate)).toEqual(['2099-03-01', '2099-03-02']);
  });

  it('returns nothing for an inactive assignment', () => {
    expect(expandOccurrences(recurring({ active: false }), '2099-03-01', '2099-03-03')).toEqual([]);
  });

  it('keeps wall-clock time across a DST boundary (luxon anchors the timezone)', () => {
    // US DST springs forward 2099-03-08; a 09:00 local rule should still read 09:00 after it.
    const occ = expandOccurrences(recurring({ startDate: '2099-03-07' }), '2099-03-07', '2099-03-09');
    expect(occ.map((o) => o.scheduledTime)).toEqual(['09:00', '09:00', '09:00']);
    // The absolute UTC offset shifts by an hour across the boundary.
    expect(occ[0].scheduledFor.endsWith('-05:00')).toBe(true); // EST before
    expect(occ[2].scheduledFor.endsWith('-04:00')).toBe(true); // EDT after
  });

  it('returns no occurrences for legacy bad stored RRULE instead of throwing', () => {
    // Stored rows can predate validation: malformed, missing FREQ, or a forbidden frequency.
    const malformed = recurring({ scheduleRule: 'NONSENSE!!' });
    const noFreq = recurring({ scheduleRule: 'INTERVAL=2' });
    const secondly = recurring({ scheduleRule: 'FREQ=SECONDLY' });
    expect(() => expandOccurrences(malformed, '2099-03-01', '2099-03-03')).not.toThrow();
    expect(expandOccurrences(malformed, '2099-03-01', '2099-03-03')).toEqual([]);
    expect(expandOccurrences(noFreq, '2099-03-01', '2099-03-03')).toEqual([]);
    expect(expandOccurrences(secondly, '2099-03-01', '2099-03-03')).toEqual([]);
  });

  it('expands a ONE_TIME assignment only when in window', () => {
    const oneTime = { ...base, scheduleType: 'ONE_TIME' as const, scheduledFor: '2099-03-05T09:00:00-05:00' };
    expect(expandOccurrences(oneTime, '2099-03-01', '2099-03-31')).toHaveLength(1);
    expect(expandOccurrences(oneTime, '2099-04-01', '2099-04-30')).toHaveLength(0);
  });
});

describe('occurrenceFor', () => {
  it('matches a real occurrence and rejects a non-occurrence time', () => {
    expect(occurrenceFor(recurring(), '2099-03-02', '09:00')).not.toBeNull();
    expect(occurrenceFor(recurring(), '2099-03-02', '10:00')).toBeNull();
  });
});
