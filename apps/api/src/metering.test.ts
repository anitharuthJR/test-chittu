/**
 * Metering, end to end through a real turn.
 *
 * The assertion that matters is the NEGATIVE one. A maths turn and a crisis turn
 * make zero model calls — that is a regression-locked invariant of the pipeline
 * — so they must produce zero metering rows. If they ever produce one, either
 * the pipeline started calling a vendor for arithmetic, or metering is inventing
 * spend. Both are worth a red build.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import type { ProviderRouter } from './providers.js';
import type { FastifyInstance } from 'fastify';

const keys = localKeyProvider(randomBytes(32), 'dev');
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => { fixture = await createTestDb(); pool = fixture.pool; }, 120_000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => { await pool.query('DELETE FROM metering'); });

/** Reports plausible token counts so metering has something to write. */
function meteringRouter(): ProviderRouter {
  return {
    route: (c) => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: `${c}-v1` }),
    async classify(_t, _h, _ctx, onUsage) {
      onUsage?.({ category: 'classifier', provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001', promptVersion: 'classifier-v1',
        tokensIn: 800, tokensOut: 6, latencyMs: 30 });
      return { label: 'SAFE', memory: null, assist: null };
    },
    async generate(_input, onUsage) {
      onUsage?.({ category: 'sandbox', provider: 'anthropic',
        model: 'claude-sonnet-5', promptVersion: 'sandbox-v1',
        tokensIn: 1200, tokensOut: 180, latencyMs: 900 });
      return 'Sunlight scatters! [CHIPS]More[/CHIPS]';
    },
  };
}

async function open_(app: FastifyInstance) {
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: { parentName: 'P', parentEmail: `m-${randomUUID()}@example.com`,
      childFirstName: 'C', country: 'IN', band: 'builder', method: 'dev_stub',
      pin: '2846', pinConfirm: '2846' },
  });
  const { consentId, challengeId } = draft.json() as { consentId: string; challengeId: string };
  const fin = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId } });
  const raw = String(fin.headers['set-cookie']).split(';')[0]!;
  const cookies = { chittu_consent: raw.slice(raw.indexOf('=') + 1) };
  const sess = await app.inject({ method: 'POST', url: '/v1/session', cookies, payload: {} });
  return { cookies, sessionId: (sess.json() as { sessionId: string }).sessionId };
}

const count = async () =>
  Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM metering`)).rows[0]!.n);

describe('metering', () => {
  it('records a row per model call on an ordinary turn', async () => {
    const app = await buildServer({ pool, keys, router: meteringRouter(), rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'why is the sky blue' } });

    const { rows } = await pool.query<{ call_type: string; tokens_in: string; cost_usd: string }>(
      `SELECT call_type, tokens_in, cost_usd FROM metering ORDER BY id`);
    expect(rows.map((r) => r.call_type).sort()).toEqual(['classifier', 'sandbox']);
    expect(Number(rows.find((r) => r.call_type === 'classifier')!.tokens_in)).toBe(800);
    // Priced, not zero: haiku at $1/MTok in, $5/MTok out.
    expect(Number(rows.find((r) => r.call_type === 'classifier')!.cost_usd)).toBeGreaterThan(0);
    await app.close();
  });

  it('a MATHS turn meters nothing, because it calls nothing', async () => {
    const app = await buildServer({ pool, keys, router: meteringRouter(), rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is 7 times 8' } });
    expect(await count(), 'arithmetic reached a vendor').toBe(0);
    await app.close();
  });

  it('a CRISIS turn meters nothing, because it calls nothing', async () => {
    const app = await buildServer({ pool, keys, router: meteringRouter(), rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'i want to die' } });
    expect(await count(), 'a crisis turn reached a vendor').toBe(0);
    await app.close();
  });

  it('the row carries no session id — only a pseudonym', async () => {
    const app = await buildServer({ pool, keys, router: meteringRouter(), rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'tell me a story' } });
    const { rows } = await pool.query<{ session_pseudonym: Buffer }>(
      `SELECT session_pseudonym FROM metering LIMIT 1`);
    expect(rows[0]!.session_pseudonym.toString('hex'))
      .not.toContain(sessionId.replace(/-/g, ''));
    await app.close();
  });

  it('a metering failure does not cost the child their answer', async () => {
    const app = await buildServer({ pool, keys, router: meteringRouter(), rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    // Break the table after the session exists.
    await pool.query(`ALTER TABLE metering RENAME TO metering_broken`);
    try {
      const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`,
        cookies, payload: { text: 'tell me a story' } });
      expect(r.statusCode, 'a telemetry failure took down a turn').toBe(200);
      expect(r.body).toMatch(/CHIPS|Sunlight|blocks/i);
    } finally {
      await pool.query(`ALTER TABLE metering_broken RENAME TO metering`);
      await app.close();
    }
  });
});
