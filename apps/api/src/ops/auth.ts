/**
 * Who may change routing, and how we know.
 *
 * THE DECISION THIS ENCODES, stated so it can be argued with.
 *
 * There is no operator identity system in Chittu, and inventing one — a users
 * table, password hashes, a reset flow — would be a larger security surface
 * than the thing it protects. So operators are configured in the environment as
 * `name=token` pairs:
 *
 *   CHITTU_OPS_TOKENS="arun@tulifo.ai=<32+ chars>,priya@tulifo.ai=<32+ chars>"
 *
 * WHAT THAT BUYS. `changed_by` in the audit comes from the TOKEN'S NAME, not
 * from a form field. The CLI takes `who` as an argument, which is self-asserted;
 * the console cannot be. That is a real improvement in the record an incident
 * review reads.
 *
 * WHAT IT COSTS, honestly. A shared bearer token is not an account. Rotating one
 * is a redeploy, a leaked one is valid until then, and there is no per-request
 * revocation. It is proportionate for a team of two or three and it is not
 * proportionate for twenty. Replace it with real SSO before the second thing is
 * true.
 *
 * WHAT IT CANNOT DO EITHER WAY. A session cannot introduce a model — the
 * compiled catalogue decides that. It cannot reach an uncleared vendor —
 * `provider_clearance` still applies per child. It cannot make an unexplained
 * change — `reason` is a CHECK constraint. The worst an attacker with a token
 * achieves is selecting the wrong REVIEWED model, visibly, in an append-only log
 * with their name on it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const OPS_COOKIE = 'chittu_ops';

/**
 * Thirty minutes. Long enough to make a change and check it landed, short
 * enough that a console left open on an unlocked laptop stops mattering
 * quickly. Same reasoning as the fifteen-minute parent session, with a little
 * more room because ops work is deliberate rather than incidental.
 */
export const OPS_TTL_MS = 30 * 60_000;

/** The shortest token we will accept. 32 chars of base64url is ~192 bits. */
const MIN_TOKEN_LENGTH = 32;

export class OpsConfigError extends Error {
  constructor(message: string) {
    super(`CHITTU_OPS_TOKENS: ${message}`);
    this.name = 'OpsConfigError';
  }
}

/**
 * token -> operator name.
 *
 * Throws rather than skipping a malformed entry. A console that silently ran
 * with one fewer operator than the deployment configured — or worse, with a
 * weak token accepted — is the kind of quiet difference this codebase keeps
 * finding the hard way.
 */
export function parseOperators(env: NodeJS.ProcessEnv): Map<string, string> {
  const raw = (env['CHITTU_OPS_TOKENS'] ?? '').trim();
  const out = new Map<string, string>();
  if (raw === '') return out;

  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=');
    if (at < 0) throw new OpsConfigError(`expected name=token, got ${JSON.stringify(entry)}`);
    const name = entry.slice(0, at).trim();
    const token = entry.slice(at + 1).trim();
    if (name === '') {
      throw new OpsConfigError('an entry has no name, and the audit records the name');
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new OpsConfigError(
        `token for ${name} is ${token.length} chars; at least ${MIN_TOKEN_LENGTH} required`);
    }
    if (out.has(token)) {
      throw new OpsConfigError(
        `two operators share a token, so the audit could not tell them apart`);
    }
    out.set(token, name);
  }
  return out;
}

/**
 * The operator this token is, or null.
 *
 * Compared in constant time against every configured token. A Map lookup would
 * be simpler and would leak, through timing, whether a guess shares a prefix
 * with a real token.
 */
export function operatorForToken(
  token: string | undefined, operators: ReadonlyMap<string, string>,
): string | null {
  if (typeof token !== 'string' || token === '') return null;
  const given = Buffer.from(token, 'utf8');
  let found: string | null = null;
  for (const [candidate, name] of operators) {
    const want = Buffer.from(candidate, 'utf8');
    // Length-check first: timingSafeEqual throws on a mismatch. The length of a
    // token is not the secret.
    if (given.length === want.length && timingSafeEqual(given, want)) found = name;
  }
  return found;
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

/**
 * `name|expiry|signature`. Signed, not stored — no table and nothing at rest.
 * The name is INSIDE the signature, so a session cannot be re-pointed at
 * another operator without invalidating it.
 */
export function mintOpsSession(name: string, key: Buffer, now: number = Date.now()): string {
  const payload = `${name}|${now + OPS_TTL_MS}`;
  return `${payload}|${sign(payload, key)}`;
}

/** @returns the operator name, or null for forged, malformed or expired. Never throws. */
export function verifyOpsSession(
  value: string | undefined, key: Buffer, now: number = Date.now(),
): string | null {
  if (typeof value !== 'string') return null;
  const cut = value.lastIndexOf('|');
  if (cut <= 0) return null;
  const payload = value.slice(0, cut);
  const given = Buffer.from(value.slice(cut + 1), 'base64url');
  const want = Buffer.from(sign(payload, key), 'base64url');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const bar = payload.lastIndexOf('|');
  if (bar <= 0) return null;
  const name = payload.slice(0, bar);
  const expiry = Number(payload.slice(bar + 1));
  if (name === '' || !Number.isFinite(expiry) || expiry <= now) return null;
  return name;
}

export function setOpsCookie(
  reply: FastifyReply, name: string, key: Buffer, secure: boolean,
): void {
  reply.setCookie(OPS_COOKIE, mintOpsSession(name, key), {
    httpOnly: true, sameSite: 'strict', secure, path: '/ops',
    maxAge: Math.floor(OPS_TTL_MS / 1000),
  });
}

export function clearOpsCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(OPS_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/ops' });
}

/** The operator this request is, if any. */
export function operatorFor(req: FastifyRequest, key: Buffer): string | null {
  return verifyOpsSession(req.cookies[OPS_COOKIE], key);
}
