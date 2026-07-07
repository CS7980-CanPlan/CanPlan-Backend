import {
  REPORT_DRAFT_TTL_SECONDS,
  signReportDraft,
  verifyReportDraft,
  type ReportDraftContent,
} from './reportDraftToken';
import { UnauthorizedError, ValidationError } from './response';
import type { ReportStats } from './types';

// A minimal but representative stats object (nested arrays + floats) to exercise canonical hashing.
const STATS = {
  meta: { userId: 'u1', from: '2026-06-01', to: '2026-06-30', basis: 'attempted-instances-only', totalInstances: 3 },
  completion: { completed: 2, skipped: 1, cancelled: 0, overdue: 0, inProgress: 0, toDo: 0, completionRate: 0.6666666666666666 },
  trend: [{ weekStart: '2026-06-01', completed: 2, total: 3, completionRate: 0.6666666666666666 }],
  byCategory: [],
  byTask: [],
  stepDwell: [],
  focus: { byTask: [], focusRatio: null },
  skipPatterns: { byTask: [], byHour: [] },
  abandonment: [],
  timeOfDay: [],
} as unknown as ReportStats;

const CONTENT: ReportDraftContent = {
  userId: 'u1',
  from: '2026-06-01',
  to: '2026-06-30',
  generatedAt: '2026-07-06T00:00:00.000Z',
  narrative: 'A plain-language summary.',
  stats: STATS,
};

const T0 = Date.parse('2026-07-06T00:00:00.000Z');

beforeAll(() => {
  process.env.REPORT_DRAFT_SIGNING_SECRET = 'unit-test-secret';
});

describe('signReportDraft / verifyReportDraft', () => {
  it('round-trips: a token signed over content verifies and returns the bound payload', () => {
    const token = signReportDraft(CONTENT, T0);
    const payload = verifyReportDraft(token, CONTENT, T0);
    expect(payload.userId).toBe('u1');
    expect(payload.from).toBe('2026-06-01');
    expect(payload.to).toBe('2026-06-30');
    expect(payload.generatedAt).toBe('2026-07-06T00:00:00.000Z');
    expect(payload.exp).toBe(Math.floor(T0 / 1000) + REPORT_DRAFT_TTL_SECONDS);
  });

  it('verifies after a JSON round-trip of the content (key order / serialization independent)', () => {
    const token = signReportDraft(CONTENT, T0);
    // Simulate the client parsing the AWSJSON and sending it back (keys may be reordered).
    const roundTripped: ReportDraftContent = {
      generatedAt: CONTENT.generatedAt,
      to: CONTENT.to,
      from: CONTENT.from,
      userId: CONTENT.userId,
      narrative: CONTENT.narrative,
      stats: JSON.parse(JSON.stringify(CONTENT.stats)),
    };
    expect(() => verifyReportDraft(token, roundTripped, T0)).not.toThrow();
  });

  it.each([
    ['narrative', { ...CONTENT, narrative: 'tampered' }],
    ['userId', { ...CONTENT, userId: 'attacker' }],
    ['from', { ...CONTENT, from: '2020-01-01' }],
    ['to', { ...CONTENT, to: '2099-01-01' }],
    ['generatedAt', { ...CONTENT, generatedAt: '2026-07-06T00:00:01.000Z' }],
    ['stats', { ...CONTENT, stats: { ...STATS, meta: { ...STATS.meta, totalInstances: 999 } } }],
  ])('rejects a tampered %s with a ValidationError', (_field, tampered) => {
    const token = signReportDraft(CONTENT, T0);
    expect(() => verifyReportDraft(token, tampered as ReportDraftContent, T0)).toThrow(ValidationError);
  });

  it('rejects an expired token (past the TTL) with an UnauthorizedError', () => {
    const token = signReportDraft(CONTENT, T0);
    const afterExpiry = T0 + (REPORT_DRAFT_TTL_SECONDS + 1) * 1000;
    expect(() => verifyReportDraft(token, CONTENT, afterExpiry)).toThrow(UnauthorizedError);
  });

  it('accepts a token right up to its expiry boundary', () => {
    const token = signReportDraft(CONTENT, T0);
    const atExpiry = T0 + REPORT_DRAFT_TTL_SECONDS * 1000;
    expect(() => verifyReportDraft(token, CONTENT, atExpiry)).not.toThrow();
  });

  it('rejects a token whose signature was altered', () => {
    const token = signReportDraft(CONTENT, T0);
    const [payloadB64] = token.split('.');
    const forged = `${payloadB64}.${Buffer.from('not-a-real-signature').toString('base64url')}`;
    expect(() => verifyReportDraft(forged, CONTENT, T0)).toThrow(UnauthorizedError);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signReportDraft(CONTENT, T0);
    process.env.REPORT_DRAFT_SIGNING_SECRET = 'a-different-secret';
    try {
      expect(() => verifyReportDraft(token, CONTENT, T0)).toThrow(UnauthorizedError);
    } finally {
      process.env.REPORT_DRAFT_SIGNING_SECRET = 'unit-test-secret';
    }
  });

  it.each([['', 'empty'], ['abc', 'no-dot'], ['a.b.c', 'too-many-parts']])(
    'rejects a malformed token (%s)',
    (token) => {
      expect(() => verifyReportDraft(token, CONTENT, T0)).toThrow();
    },
  );

  it('throws when the signing secret is not configured', () => {
    const saved = process.env.REPORT_DRAFT_SIGNING_SECRET;
    delete process.env.REPORT_DRAFT_SIGNING_SECRET;
    try {
      expect(() => signReportDraft(CONTENT, T0)).toThrow(/REPORT_DRAFT_SIGNING_SECRET/);
    } finally {
      process.env.REPORT_DRAFT_SIGNING_SECRET = saved;
    }
  });
});
