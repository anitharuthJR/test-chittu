/**
 * The parent session is the thing standing between a curious child and the
 * "erase everything" button, so it is tested as an attacker would probe it
 * rather than as a happy path.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mintParentSession, verifyParentSession, PARENT_TTL_MS } from './cookies.js';

const key = randomBytes(32);
const other = randomBytes(32);
const CONSENT = '11111111-1111-4111-8111-111111111111';

describe('parent session', () => {
  it('round-trips the consent it was minted for', () => {
    expect(verifyParentSession(mintParentSession(CONSENT, key), key)).toBe(CONSENT);
  });

  it('expires', () => {
    const t0 = 1_000_000;
    const cookie = mintParentSession(CONSENT, key, t0);
    expect(verifyParentSession(cookie, key, t0 + PARENT_TTL_MS - 1)).toBe(CONSENT);
    expect(verifyParentSession(cookie, key, t0 + PARENT_TTL_MS)).toBeNull();
    expect(verifyParentSession(cookie, key, t0 + PARENT_TTL_MS + 1)).toBeNull();
  });

  it('rejects a signature made with a different key', () => {
    expect(verifyParentSession(mintParentSession(CONSENT, other), key)).toBeNull();
  });

  it('rejects a consent id swapped after signing', () => {
    // The obvious attack: take your own valid cookie and point it at another
    // family. The id is inside the signed payload, so it cannot be edited.
    const cookie = mintParentSession(CONSENT, key);
    const forged = cookie.replace(CONSENT, '22222222-2222-4222-8222-222222222222');
    expect(verifyParentSession(forged, key)).toBeNull();
  });

  it('rejects an expiry pushed into the future', () => {
    const t0 = 1_000_000;
    const cookie = mintParentSession(CONSENT, key, t0);
    const [id, , sig] = cookie.split('|');
    const forged = `${id}|${t0 + 10 * 365 * 24 * 3600_000}|${sig}`;
    expect(verifyParentSession(forged, key, t0 + 1)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['no separators', 'nonsense'],
    ['only a separator', '|'],
    ['leading separator', '|abc'],
    ['missing signature', `${CONSENT}|${Date.now() + 60_000}`],
    ['signature is not base64url', `${CONSENT}|${Date.now() + 60_000}|!!!!`],
    ['expiry is not a number', `${CONSENT}|soon|abcd`],
  ])('returns null for %s rather than throwing', (_name, value) => {
    expect(() => verifyParentSession(value, key)).not.toThrow();
    expect(verifyParentSession(value, key)).toBeNull();
  });

  it('returns null for an absent cookie', () => {
    expect(verifyParentSession(undefined, key)).toBeNull();
  });

  it('is not the blind-index fingerprint, which lowercases its input', () => {
    // `fingerprint()` in @chittu/db trims and lowercases before hashing —
    // correct for an email, silently wrong for a signature. If this ever starts
    // failing, someone has "simplified" mintParentSession onto that helper and
    // case no longer distinguishes two different consent ids.
    const upper = 'AAAAAAAA-1111-4111-8111-111111111111';
    const lower = upper.toLowerCase();
    expect(verifyParentSession(mintParentSession(upper, key), key)).toBe(upper);
    expect(verifyParentSession(
      mintParentSession(upper, key).replace(upper, lower), key)).toBeNull();
  });
});
