/**
 * Metering: what a call cost, against a session we cannot reverse.
 *
 * §4.6 — "pseudonymised; admin sees cost, never children". The schema has no FK
 * from metering to session, deliberately, so the ops console can aggregate per
 * session without being able to reach a child.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './testing.js';
import { meteringRepo, sessionPseudonym } from './metering-repo.js';

let db: TestDb;
const KEY = randomBytes(32);
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

const usage = (over: Partial<Parameters<typeof meteringRepo.record>[2]> = {}) => ({
  category: 'classifier' as const, provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001', promptVersion: 'classifier-v1',
  tokensIn: 1000, tokensOut: 20, latencyMs: 42, ...over,
});

describe('sessionPseudonym', () => {
  it('is stable for the same session and key', () => {
    const id = randomUUID();
    expect(sessionPseudonym(id, KEY).equals(sessionPseudonym(id, KEY))).toBe(true);
  });

  it('differs between sessions', () => {
    expect(sessionPseudonym(randomUUID(), KEY)
      .equals(sessionPseudonym(randomUUID(), KEY))).toBe(false);
  });

  it('differs from the blind index over the same value — domain separation', async () => {
    // Both are HMACs under the same key. Without a domain tag, anyone holding
    // the index key could compute a session's pseudonym from its id and link
    // metering back to a child, which is the one thing this column exists to
    // prevent.
    const id = randomUUID();
    const { fingerprint } = await import('./crypto.js');
    expect(sessionPseudonym(id, KEY).equals(fingerprint(id, KEY))).toBe(false);
  });

  it('does not contain the session id', () => {
    const id = randomUUID();
    expect(sessionPseudonym(id, KEY).toString('hex')).not.toContain(id.replace(/-/g, ''));
  });
});

describe('meteringRepo.record', () => {
  it('writes one row per call, with the tokens the vendor charged for', async () => {
    const p = sessionPseudonym(randomUUID(), KEY);
    await meteringRepo.record(db.pool, p, usage(), { usd: 0.0011, inr: 0.0957, rateVersion: 'rates-test' });
    const { rows } = await db.pool.query<{
      call_type: string; provider: string; model: string; tokens_in: number;
      tokens_out: number; latency_ms: number; rate_version: string;
    }>(`SELECT call_type, provider, model, tokens_in, tokens_out, latency_ms, rate_version
          FROM metering ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({
      call_type: 'classifier', provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001', tokens_in: 1000, tokens_out: 20,
      latency_ms: 42, rate_version: 'rates-test',
    });
  });

  it('stores no text of any kind — the columns cannot hold one', async () => {
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'metering' AND table_schema = current_schema()`);
    const names = rows.map((r) => r.column_name).sort();
    // Enumerated, so a column added later has to be justified here.
    expect(names).toEqual([
      'cache_read_tokens', 'call_type', 'cost_inr', 'cost_usd', 'created_at',
      'id', 'latency_ms', 'model', 'prompt_version', 'provider',
      'rate_version', 'session_pseudonym', 'tokens_in', 'tokens_out',
    ]);
  });

  it('cost is recomputable from what is stored', async () => {
    const p = sessionPseudonym(randomUUID(), KEY);
    await meteringRepo.record(db.pool, p, usage({ tokensIn: 1_000_000, tokensOut: 0 }),
      { usd: 1, inr: 87, rateVersion: 'rates-test' });
    const { rows } = await db.pool.query<{ tokens_in: string; tokens_out: string }>(
      `SELECT tokens_in, tokens_out FROM metering ORDER BY id DESC LIMIT 1`);
    // 1M in at $3/MTok would be $3 — derivable without re-asking the vendor.
    const reprice = Number(rows[0]!.tokens_in) / 1e6 * 3;
    expect(reprice).toBeCloseTo(3, 9);
  });

  it('aggregates by pseudonym without touching a session row', async () => {
    const p = sessionPseudonym(randomUUID(), KEY);
    await meteringRepo.record(db.pool, p, usage(), { usd: 1, inr: 87, rateVersion: 'v' });
    await meteringRepo.record(db.pool, p, usage({ category: 'sandbox' }),
      { usd: 2, inr: 174, rateVersion: 'v' });
    const { rows } = await db.pool.query<{ n: string; usd: string }>(
      `SELECT count(*)::text AS n, sum(cost_usd)::text AS usd
         FROM metering WHERE session_pseudonym = $1`, [p]);
    expect(rows[0]!.n).toBe('2');
    expect(Number(rows[0]!.usd)).toBeCloseTo(3, 6);
  });
});
