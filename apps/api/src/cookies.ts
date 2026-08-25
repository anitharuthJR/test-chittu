/**
 * Two cookies, and why neither is readable from JavaScript.
 *
 * The consent token is a bearer credential: whoever holds it can open a session
 * as that child. It used to be returned in the `finalize` response body and kept
 * in `localStorage`, which put it inside reach of any script the page ever runs
 * — including one injected by a compromised dependency — and inside reach of an
 * eleven-year-old who has discovered devtools. `httpOnly` removes both.
 *
 * The parent session is new. Before this, `DELETE /v1/consent/:id` needed only a
 * consent id, and the client was holding one in `localStorage`: a child could
 * erase their own account, and so could anyone who ever saw that id. PIN
 * verification now issues a short-lived signed cookie, and the destructive
 * routes require it. That is the binding architecture §4.5 says "MUST be behind
 * PIN verification before this ships".
 *
 * **The parent session is signed, not stored.** An HMAC over
 * `consentId|expiry` under the same deterministic index key the blind indexes
 * use. No table, no migration, and nothing to leak at rest. The cost is that it
 * cannot be revoked before it expires — which is why fifteen minutes is the
 * whole lifetime, and why erasing the consent makes the id inside it resolve to
 * nothing anyway.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const CONSENT_COOKIE = 'chittu_consent';
export const PARENT_COOKIE = 'chittu_parent';
export const IDCHECK_COOKIE = 'chittu_idcheck';

/** Long enough that a family is not re-enrolled weekly; short enough to matter. */
const CONSENT_MAX_AGE = 90 * 24 * 60 * 60;      // seconds

/**
 * Fifteen minutes. A parent looks at the dashboard and leaves the tablet on the
 * sofa; the window in which the child who picks it up is still "the parent"
 * should be small enough to be uninteresting.
 */
export const PARENT_TTL_MS = 15 * 60_000;

export interface CookieEnv {
  /** `Secure` is omitted in dev so the cookie works over plain-HTTP localhost. */
  readonly env: 'dev' | 'staging' | 'prod';
}

function base(opts: CookieEnv) {
  return {
    httpOnly: true,
    // Strict, not Lax. Nothing here is reached by following a link from
    // elsewhere, so there is no flow that Strict breaks — and a child's session
    // must not be openable by any other site's request.
    sameSite: 'strict' as const,
    secure: opts.env !== 'dev',
    path: '/',
  };
}

export function setConsentCookie(
  reply: FastifyReply, token: string, opts: CookieEnv,
): void {
  reply.setCookie(CONSENT_COOKIE, token, { ...base(opts), maxAge: CONSENT_MAX_AGE });
}

export function clearConsentCookie(reply: FastifyReply, opts: CookieEnv): void {
  reply.clearCookie(CONSENT_COOKIE, base(opts));
}

export function readConsentCookie(req: FastifyRequest): string | null {
  const v = req.cookies[CONSENT_COOKIE];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Parent session
// ---------------------------------------------------------------------------

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

/**
 * NOT `fingerprint()` from @chittu/db, deliberately. That helper lowercases and
 * trims its input before hashing — correct for an email blind index, silently
 * wrong for a signature, where `A` and `a` must not agree.
 */
export function mintParentSession(
  consentId: string, key: Buffer, now: number = Date.now(),
): string {
  const expiry = now + PARENT_TTL_MS;
  const payload = `${consentId}|${expiry}`;
  return `${payload}|${sign(payload, key)}`;
}

/**
 * @returns the consent id the session is for, or null if the value is forged,
 *   malformed, or expired. Never throws: a bad cookie is an ordinary event.
 */
export function verifyParentSession(
  value: string | undefined, key: Buffer, now: number = Date.now(),
): string | null {
  if (typeof value !== 'string') return null;
  const cut = value.lastIndexOf('|');
  if (cut <= 0) return null;
  const payload = value.slice(0, cut);
  const given = Buffer.from(value.slice(cut + 1), 'base64url');
  const want = Buffer.from(sign(payload, key), 'base64url');
  // Compared in constant time, and length-checked first because timingSafeEqual
  // throws on a mismatch rather than returning false.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const bar = payload.indexOf('|');
  if (bar <= 0) return null;
  const consentId = payload.slice(0, bar);
  const expiry = Number(payload.slice(bar + 1));
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  return consentId;
}

export function setParentCookie(
  reply: FastifyReply, consentId: string, key: Buffer, opts: CookieEnv,
): void {
  reply.setCookie(PARENT_COOKIE, mintParentSession(consentId, key), {
    ...base(opts), maxAge: Math.floor(PARENT_TTL_MS / 1000),
  });
}

export function clearParentCookie(reply: FastifyReply, opts: CookieEnv): void {
  reply.clearCookie(PARENT_COOKIE, base(opts));
}

/** The consent id this request is an authenticated parent for, if any. */
export function parentFor(req: FastifyRequest, key: Buffer): string | null {
  return verifyParentSession(req.cookies[PARENT_COOKIE], key);
}

// ---------------------------------------------------------------------------
// Pending ID check
// ---------------------------------------------------------------------------

/**
 * An hour. Long enough to find your passport and a well-lit wall; short enough
 * that a shared tablet does not carry somebody else's half-finished check.
 */
export const IDCHECK_TTL_MS = 60 * 60_000;

/**
 * Which verification this browser is part-way through.
 *
 * WHY A COOKIE AT ALL. The parent leaves for the vendor's hosted page and comes
 * back, so every scrap of client state is gone. The alternatives were worse:
 * `localStorage` is forbidden here and asserted against, and putting the consent
 * id in the return URL publishes it to the vendor, to browser history, and to
 * anything that logs a Referer.
 *
 * SIGNED, NOT STORED — the same trick as the parent session. An HMAC over
 * `consentId|challengeId|expiry` under the deterministic index key. No table, no
 * migration, nothing at rest.
 *
 * **`sameSite` is Lax here, and Strict everywhere else in this file.** That is
 * not an oversight and must not be "fixed": the parent returns from the vendor
 * by a cross-site top-level navigation, and a Strict cookie is NOT SENT on one.
 * With Strict this cookie is invisible on exactly the request it exists for, and
 * every ID check would land back on an empty form having apparently forgotten
 * the parent. Lax is the weakest relaxation that permits it — the cookie still
 * rides no cross-site POST, no iframe and no subresource.
 *
 * The relaxation is affordable because this cookie is not a credential. It names
 * a pending verification; it cannot approve one. The verdict is still fetched
 * from the vendor by this server, over its own connection, on the strength of an
 * API key the browser never sees.
 */
export interface PendingIdCheck {
  readonly consentId: string;
  readonly challengeId: string;
}

export function mintIdCheck(
  pending: PendingIdCheck, key: Buffer, now: number = Date.now(),
): string {
  const payload = `${pending.consentId}|${pending.challengeId}|${now + IDCHECK_TTL_MS}`;
  return `${payload}|${sign(payload, key)}`;
}

/** @returns the pending check, or null if forged, malformed, or expired. */
export function verifyIdCheck(
  value: string | undefined, key: Buffer, now: number = Date.now(),
): PendingIdCheck | null {
  if (typeof value !== 'string') return null;
  const cut = value.lastIndexOf('|');
  if (cut <= 0) return null;
  const payload = value.slice(0, cut);
  const given = Buffer.from(value.slice(cut + 1), 'base64url');
  const want = Buffer.from(sign(payload, key), 'base64url');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const parts = payload.split('|');
  if (parts.length !== 3) return null;
  const [consentId, challengeId, rawExpiry] = parts as [string, string, string];
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  if (consentId === '' || challengeId === '') return null;
  return { consentId, challengeId };
}

export function setIdCheckCookie(
  reply: FastifyReply, pending: PendingIdCheck, key: Buffer, opts: CookieEnv,
): void {
  reply.setCookie(IDCHECK_COOKIE, mintIdCheck(pending, key), {
    httpOnly: true,
    sameSite: 'lax',          // see above — Strict is invisible on the return hop
    secure: opts.env !== 'dev',
    path: '/',
    maxAge: Math.floor(IDCHECK_TTL_MS / 1000),
  });
}

export function clearIdCheckCookie(reply: FastifyReply, opts: CookieEnv): void {
  reply.clearCookie(IDCHECK_COOKIE, {
    httpOnly: true, sameSite: 'lax', secure: opts.env !== 'dev', path: '/',
  });
}

/** The verification this browser is part-way through, if any. */
export function pendingIdCheck(req: FastifyRequest, key: Buffer): PendingIdCheck | null {
  return verifyIdCheck(req.cookies[IDCHECK_COOKIE], key);
}
