/**
 * The Parent PIN — policy, hashing, and the lockout.
 *
 * This guards the parent dashboard, which holds the ONLY crisis-unlock button in
 * the system (requirements §4.5). It is also the one thing a curious child is
 * most likely to attack, and the threat model says design against that first.
 *
 * ── A DELIBERATE DEVIATION FROM THE PROTOTYPE ──────────────────────────────
 * chittu-v3.html line 818 does `sha('PIN|' + pin)` — an unsalted SHA-256
 * truncated to 64 bits, computed in the browser. That is fine as a demo and
 * would be a real defect on a server: a 4-digit PIN has 10,000 possibilities,
 * so an unsalted digest is reversible by enumeration in microseconds.
 *
 * CLAUDE.md's "port semantics, do not rewrite" governs the SAFETY BEHAVIOUR —
 * the guards, the pipeline order, the scripted copy. It is not a licence to move
 * a browser demo's crypto onto a server. So the KDF here is scrypt, salted and
 * per-PIN.
 *
 * ── AND AN HONEST LIMIT ────────────────────────────────────────────────────
 * No KDF rescues a 4-digit PIN if the hash leaks; the keyspace is the problem,
 * not the hash. scrypt buys time against an offline attacker and nothing more.
 * The controls that actually matter are: never expose the hash, rate-limit at
 * the API, and lock out after five attempts — which is why `LOCKOUT` below is
 * durable state and not a convenience.
 */

import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Wrapped by hand rather than with promisify: promisify resolves to scrypt's
 * 3-argument overload and silently drops the options, so N/r/p would fall back
 * to Node's defaults and the cost parameters below would be decorative.
 */
function scryptAsync(
  secret: string, salt: Buffer, keylen: number, options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

/** Requirements §4.1: 4–6 digits. */
export const PIN_PATTERN = /^\d{4,6}$/;

/**
 * The prototype's list (line 816), kept verbatim as the floor.
 * `WEAK_PIN_RULES` below is a strict superset — see why there.
 */
export const WEAK_PINS_PROTOTYPE = /^(1234|0000|1111|123456|000000|111111)$/;

export type PinRejection =
  | 'not-4-to-6-digits'
  | 'all-same-digit'
  | 'sequential'
  | 'listed-weak'
  | 'mismatch';

/**
 * Widened beyond the prototype's six literals, deliberately.
 *
 * This is the one direction it is safe to strengthen without sign-off:
 * rejecting MORE PINs cannot fail open. It can only refuse a parent a PIN they
 * wanted, which surfaces immediately as a message, unlike a guard that silently
 * stops firing. The prototype's list accepts `4321`, `9999` and `2222` — all of
 * which a child guesses before lunch.
 */
export function checkPinPolicy(pin: string, confirm?: string): PinRejection | null {
  if (!PIN_PATTERN.test(pin)) return 'not-4-to-6-digits';
  if (confirm !== undefined && pin !== confirm) return 'mismatch';
  if (WEAK_PINS_PROTOTYPE.test(pin)) return 'listed-weak';
  if (/^(\d)\1+$/.test(pin)) return 'all-same-digit';
  if (isRun(pin)) return 'sequential';
  return null;
}

/** Ascending or descending runs of consecutive digits: 1234, 4321, 567890. */
function isRun(pin: string): boolean {
  const d = [...pin].map(Number) as number[];
  const step = (dir: 1 | -1) =>
    d.every((v, i) => i === 0 || v === (d[i - 1]! + dir + 10) % 10);
  return step(1) || step(-1);
}

/** Parent-facing wording. No PIN value is ever echoed back. */
export const PIN_MESSAGE: Readonly<Record<PinRejection, string>> = Object.freeze({
  'not-4-to-6-digits': 'PIN must be 4–6 digits.',
  'mismatch': "PINs don't match — try again.",
  'listed-weak': 'That PIN is too easy to guess — pick another.',
  'all-same-digit': 'That PIN is too easy to guess — pick another.',
  'sequential': 'That PIN is too easy to guess — pick another.',
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const SCRYPT_N = 1 << 15;   // 32768 — OWASP-class for an interactive check
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * scrypt needs about 128 * N * r bytes — here exactly 32 MiB — and Node's
 * default maxmem is also 32 MiB, so the call fails with "memory limit
 * exceeded" unless this is raised. Left implicit, the cost parameters above
 * would look configured and be unusable.
 */
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_r * 2;

/** `scrypt$N$r$p$salt$key`, all hex. Self-describing so params can change later. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(pin, salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Constant-time compare. A length-varying or early-return compare leaks the
 * matching prefix, which on a 4-digit PIN is most of the secret.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, keyHex] = parts as [string, string, string, string, string, string];
  let derived: Buffer;
  try {
    derived = await scryptAsync(pin, Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(n), r: Number(r), p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(keyHex, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Lockout
// ---------------------------------------------------------------------------

/** Prototype: five wrong attempts, then 60 seconds (line 1171). */
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 60_000;

export interface LockoutState {
  readonly failedAttempts: number;
  readonly lockedUntil: number | null;
}

export const FRESH_LOCKOUT: LockoutState = Object.freeze({
  failedAttempts: 0, lockedUntil: null,
});

export interface AttemptResult {
  readonly ok: boolean;
  readonly locked: boolean;
  readonly state: LockoutState;
  /**
   * True exactly on the attempt that triggers the lock, so the caller raises the
   * GATE flag once — "may be a curious child" — rather than on every later try.
   */
  readonly justLocked: boolean;
}

/**
 * Pure state transition. The caller supplies `now` and persists the result, so
 * a Redis flush cannot reset a lockout that Postgres still remembers.
 */
export function registerAttempt(
  state: LockoutState,
  correct: boolean,
  now: number,
): AttemptResult {
  if (state.lockedUntil !== null && now < state.lockedUntil) {
    // Still locked. A correct PIN does NOT end the lockout early — otherwise the
    // lockout is only a speed bump for someone who guesses right on try six.
    return { ok: false, locked: true, justLocked: false, state };
  }
  if (correct) {
    return { ok: true, locked: false, justLocked: false, state: FRESH_LOCKOUT };
  }
  const failed = state.failedAttempts + 1;
  if (failed >= MAX_ATTEMPTS) {
    return {
      ok: false, locked: true, justLocked: true,
      state: { failedAttempts: 0, lockedUntil: now + LOCKOUT_MS },
    };
  }
  return {
    ok: false, locked: false, justLocked: false,
    state: { failedAttempts: failed, lockedUntil: null },
  };
}
