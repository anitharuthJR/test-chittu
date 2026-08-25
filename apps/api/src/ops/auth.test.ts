/**
 * Ops authentication.
 *
 * The console can repoint which model serves children. That is bounded — the
 * compiled catalogue and provider_clearance still apply, so the worst a session
 * can do is select the wrong REVIEWED model — but it is not nothing, and these
 * tests pin the properties that keep it bounded.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  parseOperators, operatorForToken, mintOpsSession, verifyOpsSession,
  OPS_TTL_MS, OpsConfigError,
} from './auth.js';

const KEY = randomBytes(32);
const TOK_A = 'a'.repeat(32);
const TOK_B = 'b'.repeat(32);

describe('operator tokens come from the environment, with names attached', () => {
  it('parses name=token pairs', () => {
    const ops = parseOperators({ CHITTU_OPS_TOKENS: `arun@tulifo.ai=${TOK_A},priya@tulifo.ai=${TOK_B}` });
    expect(ops.size).toBe(2);
    expect(operatorForToken(TOK_A, ops)).toBe('arun@tulifo.ai');
    expect(operatorForToken(TOK_B, ops)).toBe('priya@tulifo.ai');
  });

  it('is empty when unset — the console must not exist by default', () => {
    expect(parseOperators({}).size).toBe(0);
    expect(parseOperators({ CHITTU_OPS_TOKENS: '' }).size).toBe(0);
  });

  it('REFUSES a short token rather than accepting a guessable one', () => {
    expect(() => parseOperators({ CHITTU_OPS_TOKENS: 'arun@tulifo.ai=hunter2' }))
      .toThrow(OpsConfigError);
  });

  it('REFUSES an entry with no name, because changed_by comes from the name', () => {
    expect(() => parseOperators({ CHITTU_OPS_TOKENS: `=${TOK_A}` })).toThrow(OpsConfigError);
  });

  it('REFUSES two operators sharing a token', () => {
    expect(() => parseOperators({
      CHITTU_OPS_TOKENS: `arun@tulifo.ai=${TOK_A},priya@tulifo.ai=${TOK_A}`,
    })).toThrow(OpsConfigError);
  });

  it('an unknown token is nobody', () => {
    const ops = parseOperators({ CHITTU_OPS_TOKENS: `arun@tulifo.ai=${TOK_A}` });
    expect(operatorForToken(TOK_B, ops)).toBeNull();
    expect(operatorForToken('', ops)).toBeNull();
    expect(operatorForToken(undefined, ops)).toBeNull();
  });

  it('a token that is a prefix of a real one is nobody', () => {
    const ops = parseOperators({ CHITTU_OPS_TOKENS: `arun@tulifo.ai=${TOK_A}` });
    expect(operatorForToken(TOK_A.slice(0, 31), ops)).toBeNull();
    expect(operatorForToken(TOK_A + 'x', ops)).toBeNull();
  });
});

describe('the session is signed, short-lived and carries the operator', () => {
  it('round-trips the name', () => {
    const s = mintOpsSession('arun@tulifo.ai', KEY);
    expect(verifyOpsSession(s, KEY)).toBe('arun@tulifo.ai');
  });

  it('rejects a forged signature', () => {
    const s = mintOpsSession('arun@tulifo.ai', KEY);
    expect(verifyOpsSession(s, randomBytes(32))).toBeNull();
  });

  it('rejects a name swapped after signing — the whole point of signing it', () => {
    const s = mintOpsSession('arun@tulifo.ai', KEY);
    const tampered = s.replace('arun@tulifo.ai', 'attacker@evil.example');
    expect(verifyOpsSession(tampered, KEY)).toBeNull();
  });

  it('expires', () => {
    const now = Date.now();
    const s = mintOpsSession('arun@tulifo.ai', KEY, now);
    expect(verifyOpsSession(s, KEY, now + OPS_TTL_MS - 1)).toBe('arun@tulifo.ai');
    expect(verifyOpsSession(s, KEY, now + OPS_TTL_MS + 1)).toBeNull();
  });

  it('never throws on rubbish', () => {
    for (const v of [undefined, '', 'x', 'a|b', 'a|b|c', '||']) {
      expect(() => verifyOpsSession(v as string | undefined, KEY)).not.toThrow();
      expect(verifyOpsSession(v as string | undefined, KEY)).toBeNull();
    }
  });

  it('is shorter-lived than a working day', () => {
    expect(OPS_TTL_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
