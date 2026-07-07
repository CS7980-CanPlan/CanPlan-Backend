/**
 * Signed draft tokens for the two-step AI progress report flow.
 *
 * `generateReport` computes the stats + AI narrative but persists nothing. To let the
 * frontend show a preview and then save the *exact same* report later without the server
 * recomputing (or trusting) anything, `generateReport` returns a server-signed `draftToken`
 * alongside the content. `saveReport` re-submits the content plus that token; we recompute a
 * canonical hash of the submitted content and verify it against the signed payload, so a
 * stale, expired, or tampered draft is rejected before anything is written.
 *
 * The token is an HMAC-SHA256 (Node `crypto`) over a compact payload — we sign a canonical
 * content HASH rather than embedding the full narrative/stats, so the token stays small. The
 * signing secret is a backend-only Lambda env var (REPORT_DRAFT_SIGNING_SECRET); it is read
 * lazily so a misconfiguration fails closed at call time (never signs/verifies with an empty
 * secret) rather than silently using a weak default.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { UnauthorizedError, ValidationError } from './response';
import type { ReportStats } from './types';

/** How long a signed draft stays valid before `saveReport` must regenerate it. */
export const REPORT_DRAFT_TTL_SECONDS = 15 * 60; // 15 minutes

/** Payload schema version — bump if the signed shape ever changes. */
const DRAFT_TOKEN_VERSION = 1;

/**
 * The report content a draft token binds. Identical between `generateReport` (what was
 * produced) and `saveReport` (what the client re-submits); the canonical hash of these
 * fields is what the token signs.
 */
export interface ReportDraftContent {
  userId: string;
  from: string;
  to: string;
  generatedAt: string;
  narrative: string;
  stats: ReportStats;
}

/** The verified, server-signed claims returned by {@link verifyReportDraft}. */
export interface ReportDraftPayload {
  v: number;
  userId: string;
  from: string;
  to: string;
  generatedAt: string;
  /** Canonical SHA-256 (hex) of the bound content. */
  contentHash: string;
  /** Absolute expiry, epoch seconds. */
  exp: number;
}

/**
 * Read the signing secret at call time. Throws a plain Error (surfaced as INTERNAL) when it
 * is unset — a server-config problem, not a client error — so we never sign or verify with an
 * empty key.
 */
function requireSigningSecret(): string {
  const secret = process.env.REPORT_DRAFT_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      'REPORT_DRAFT_SIGNING_SECRET is not configured; the reports Lambda cannot sign or verify ' +
        'report draft tokens',
    );
  }
  return secret;
}

/**
 * Deterministic serialization: object keys are sorted recursively (arrays keep their order),
 * so two structurally-equal objects always produce the same string regardless of key order —
 * essential because the stats object round-trips through the client (AWSJSON) between
 * generate and save and may come back with reordered keys.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/** Canonical SHA-256 (hex) of the full bound content. */
function contentHash(content: ReportDraftContent): string {
  const canonical = canonicalize({
    userId: content.userId,
    from: content.from,
    to: content.to,
    generatedAt: content.generatedAt,
    narrative: content.narrative,
    stats: content.stats,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** HMAC-SHA256 of the base64url payload, itself base64url-encoded. */
function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** Constant-time string compare that also guards against length leaks. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Sign a freshly generated report. Returns an opaque `<payload>.<signature>` token binding the
 * content hash, the date range, the target user, `generatedAt`, and a 15-minute expiry.
 * `nowMs` is injectable only for tests; production callers omit it.
 */
export function signReportDraft(content: ReportDraftContent, nowMs: number = Date.now()): string {
  const secret = requireSigningSecret();
  const payload: ReportDraftPayload = {
    v: DRAFT_TOKEN_VERSION,
    userId: content.userId,
    from: content.from,
    to: content.to,
    generatedAt: content.generatedAt,
    contentHash: contentHash(content),
    exp: Math.floor(nowMs / 1000) + REPORT_DRAFT_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * Verify a draft token against the re-submitted content. Returns the signed payload on success;
 * throws when the token is malformed, its signature is invalid, it has expired, or its bound
 * content hash does not match the submitted content (a stale or tampered draft). Signature and
 * version/expiry failures are `UnauthorizedError`; a content mismatch is a `ValidationError`.
 * `nowMs` is injectable only for tests.
 */
export function verifyReportDraft(
  token: string,
  content: ReportDraftContent,
  nowMs: number = Date.now(),
): ReportDraftPayload {
  const secret = requireSigningSecret();
  if (typeof token !== 'string' || !token) {
    throw new ValidationError('draftToken is required');
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UnauthorizedError('draftToken is malformed');
  }
  const [payloadB64, signature] = parts;

  // Verify the signature FIRST (over the raw base64url) so we never parse an unauthenticated
  // payload as trusted data.
  if (!safeEqual(signature, sign(payloadB64, secret))) {
    throw new UnauthorizedError('draftToken signature is invalid');
  }

  let payload: ReportDraftPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as ReportDraftPayload;
  } catch {
    throw new UnauthorizedError('draftToken payload is malformed');
  }
  if (payload.v !== DRAFT_TOKEN_VERSION) {
    throw new UnauthorizedError('draftToken version is unsupported; regenerate the report');
  }
  if (typeof payload.exp !== 'number' || Math.floor(nowMs / 1000) > payload.exp) {
    throw new UnauthorizedError('draftToken has expired; regenerate the report');
  }

  // The single source of truth: recompute the canonical hash from the SUBMITTED content and
  // compare it to the signed hash. Any change to userId/from/to/generatedAt/narrative/stats
  // changes the hash, so this one check rejects every tampered or stale field.
  if (!safeEqual(contentHash(content), payload.contentHash)) {
    throw new ValidationError(
      'draftToken does not match the submitted report content (stale or tampered draft); ' +
        'regenerate the report',
    );
  }

  return payload;
}
