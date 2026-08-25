/**
 * The reading coach, end to end over the API.
 *
 * The load-bearing assertions are the counting ones: a reading turn makes
 * ZERO model calls (proved against the injected router, the way the maths
 * engine's proof works — never by inspection) and writes ZERO metering rows.
 * And the doctrine one: the transcript still passes the L1 lexicon, because a
 * child reading aloud can say something that needs the crisis spine.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ClassifierOutcome, TurnResponse } from '@chittu/contracts';
import { randomBytes } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import { CONSENT_COOKIE, PARENT_COOKIE } from './cookies.js';
import type { ProviderRouter } from './providers.js';

interface Counting extends ProviderRouter {
  readonly calls: { classifier: number; sandbox: number };
}

function countingRouter(): Counting {
  const calls = { classifier: 0, sandbox: 0 };
  return {
    calls,
    route: (c) => ({ provider: 'test', model: 'test-0', promptVersion: `${c}-v0` }),
    async classify() {
      calls.classifier += 1;
      return { label: 'SAFE', memory: null, assist: null } satisfies ClassifierOutcome;
    },
    async generate() { calls.sandbox += 1; return 'A model answered.'; },
  };
}

let app: FastifyInstance;
let router: Counting;
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keys = localKeyProvider(randomBytes(32), 'dev');

beforeAll(async () => {
  fixture = await createTestDb();
  pool = fixture.pool;
}, 180_000);

afterAll(async () => { await fixture.close(); });

let seq = 0;
beforeEach(async () => {
  router = countingRouter();
  app = await buildServer({ pool, keys, router, rateLimitMax: 100_000 });
  await app.ready();
});
afterEach(async () => { await app.close(); });

function jar(consent?: string, parent?: string): Record<string, string> {
  const parts: string[] = [];
  if (consent !== undefined) parts.push(`${CONSENT_COOKIE}=${consent}`);
  if (parent !== undefined) parts.push(`${PARENT_COOKIE}=${parent}`);
  return parts.length > 0 ? { cookie: parts.join('; ') } : {};
}

async function grantConsent(over: Record<string, unknown> = {}) {
  const d = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: {
      parentName: 'Lakshmi', parentEmail: `read${++seq}@example.com`,
      childFirstName: 'Meera', country: 'IN',
      band: 'builder', board: 'CBSE', method: 'dev_stub',
      pin: '4917', pinConfirm: '4917', ...over,
    },
  });
  expect(d.statusCode, d.body).toBe(201);
  const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
  const f = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`,
    payload: { challengeId },
  });
  expect(f.statusCode, f.body).toBe(200);
  const cookie = f.cookies.find((c) => c.name === CONSENT_COOKIE);
  expect(cookie).toBeDefined();
  return { consentId, cookie: cookie!.value };
}

async function openSession(over: Record<string, unknown> = {}) {
  const { cookie } = await grantConsent(over);
  const res = await app.inject({
    method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return { sessionId: res.json<{ sessionId: string }>().sessionId, cookie };
}

async function readAloud(id: string, passageId: string, transcript: string) {
  const res = await app.inject({
    method: 'POST', url: `/v1/session/${id}/read`,
    payload: { passageId, transcript },
  });
  return { status: res.statusCode, body: res.json<TurnResponse>() };
}

const shown = (body: TurnResponse) =>
  body.blocks.map((b) =>
    b.kind === 'chips' ? b.chips.join(' ')
    : b.kind === 'steps' ? b.items.join(' ')
    : b.kind === 'big' ? b.emoji
    : b.text).join(' ');

const MAT = 'explorer-1';   // "The cat sat on a big red mat."

// ---------------------------------------------------------------------------

describe('POST /v1/session/:id/read', () => {
  it('scores a clean read, celebrates, and calls ZERO models', async () => {
    const { sessionId } = await openSession();
    const r = await readAloud(sessionId, MAT, 'the cat sat on a big red mat');
    expect(r.status).toBe(200);
    expect(router.calls, 'a reading turn must never reach a model')
      .toEqual({ classifier: 0, sandbox: 0 });
    expect(r.body.reading).toBeDefined();
    expect(r.body.reading!.passageId).toBe(MAT);
    expect(r.body.reading!.words.every((w) => w.hit)).toBe(true);
    expect(r.body.reading!.line).toBe('⭐ Perfect! Every word! ⭐');
    expect(r.body.trace).toBe('READING COACH · celebrate');
    expect(shown(r.body)).toContain('every single word');
    expect(r.body.layers).toEqual(
      ['SEAL', 'CRISIS_LOCK', 'READ', 'L1_LEXICON', 'RENDER', 'LEDGER']);
  });

  it('writes ZERO metering rows — the observable form of "no vendor was paid"', async () => {
    const { sessionId } = await openSession();
    await readAloud(sessionId, MAT, 'the cat sat on a big red mat');
    await readAloud(sessionId, MAT, 'the cat sat');
    const rows = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM metering');
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('marks a dropped word, names it for practice, and counts the attempt', async () => {
    const { sessionId } = await openSession();
    const r = await readAloud(sessionId, MAT, 'the cat sat on a big mat');
    expect(r.status).toBe(200);
    expect(r.body.reading!.hits).toBe(7);
    expect(r.body.reading!.total).toBe(8);
    expect(r.body.reading!.words[6]).toEqual({ word: 'red', hit: false });
    expect(shown(r.body)).toContain('practice these words together: red');

    const s = await pool.query<{ read_attempts: number; read_words: number; read_hits: number }>(
      `SELECT read_attempts, read_words, read_hits FROM session WHERE id = $1`, [sessionId]);
    expect(s.rows[0]).toEqual({ read_attempts: 1, read_words: 8, read_hits: 7 });
  });

  it('feeds the accuracy into the parent dashboard stats', async () => {
    const { sessionId, cookie } = await openSession();
    await readAloud(sessionId, MAT, 'the cat sat on a big red mat');
    await readAloud(sessionId, MAT, 'the cat sat on a big mat');
    const v = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(cookie), payload: { pin: '4917' },
    });
    const parent = v.cookies.find((c) => c.name === PARENT_COOKIE)!.value;
    const d = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(cookie, parent),
    });
    expect(d.statusCode).toBe(200);
    const stats = d.json<{ stats: {
      readingAttempts: number; readingWords: number; readingHits: number;
    }; }>().stats;
    expect(stats.readingAttempts).toBe(2);
    expect(stats.readingWords).toBe(16);
    expect(stats.readingHits).toBe(15);
  });

  /**
   * The doctrine test. The prototype scored a read-aloud attempt BEFORE the
   * L1 fast path (chittu-v3.html:1046 vs :1061); the port corrects that. A
   * transcript that needs the crisis spine gets the crisis spine — "they were
   * only reading" is not a reason to skip a layer.
   */
  it('a crisis phrase in the transcript fires the spine, not the scorer', async () => {
    const { sessionId } = await openSession();
    const r = await readAloud(sessionId, MAT, 'i dont want to be here anymore');
    expect(r.status).toBe(200);
    expect(router.calls).toEqual({ classifier: 0, sandbox: 0 });
    expect(r.body.crisisLock).toBe(true);
    expect(r.body.reading, 'a guarded turn is never scored').toBeUndefined();
    expect(shown(r.body)).not.toContain('great reading');

    // The attempt did not count as reading practice…
    const s = await pool.query<{ read_attempts: number }>(
      `SELECT read_attempts FROM session WHERE id = $1`, [sessionId]);
    expect(s.rows[0]!.read_attempts).toBe(0);

    // …and the lock is durable: the next turn, in any mode, is calm-mode.
    const next = await app.inject({
      method: 'POST', url: `/v1/session/${sessionId}/turn`,
      payload: { text: 'tell me a joke' },
    });
    expect(next.json<TurnResponse>().trace).toContain('calm-mode');
    expect(router.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('a crisis-locked session ignores the passage and stays calm', async () => {
    const { sessionId } = await openSession();
    await readAloud(sessionId, MAT, 'i dont want to be here anymore');
    const r = await readAloud(sessionId, MAT, 'the cat sat on a big red mat');
    expect(r.body.reading).toBeUndefined();
    expect(r.body.crisisLock).toBe(true);
    expect(r.body.trace).toBe('CRISIS SPINE · calm-mode companion');
    expect(router.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('refuses an unknown passage id in words, before the pipeline', async () => {
    const { sessionId } = await openSession();
    const r = await readAloud(sessionId, 'explorer-99', 'the cat sat');
    expect(r.status).toBe(404);
    expect((r.body as unknown as { error: string }).error).toBe('no such passage');
  });

  it('404s an unknown session', async () => {
    const r = await readAloud('00000000-0000-0000-0000-000000000000', MAT, 'the cat');
    expect(r.status).toBe(404);
  });

  it('stores the attempt and the reply as read-mode messages', async () => {
    const { sessionId } = await openSession();
    await readAloud(sessionId, MAT, 'the cat sat on a big mat');
    const m = await pool.query<{ role: string; mode: string }>(
      `SELECT role, mode FROM message WHERE session_id = $1 ORDER BY seq`, [sessionId]);
    expect(m.rows).toEqual([
      { role: 'child', mode: 'read' },
      { role: 'chittu', mode: 'read' },
    ]);
  });

  it('seals attempt, reply, and a words-free score marker', async () => {
    const { sessionId } = await openSession();
    await readAloud(sessionId, MAT, 'the cat sat on a big mat');
    const seal = await app.inject({ method: 'GET', url: `/v1/session/${sessionId}/seal` });
    expect(seal.json<{ ok: boolean; records: number }>()).toMatchObject({
      ok: true, records: 3,
    });
    const marker = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE session_id = $1 AND layer = 'READ'`, [sessionId]);
    expect(marker.rows[0]!.n).toBe(1);
  });

  /**
   * The teen carve-out holds here exactly as it does for chat: a thinker's
   * transcript body is never written (the CHECK plus addMessage agree), while
   * the three counters — aggregates, no words — still move.
   */
  it("a thinker's attempt counts, and their words are not stored", async () => {
    const { sessionId } = await openSession({ band: 'thinker' });
    const r = await readAloud(sessionId, 'thinker-2',
      'although the experiment failed twice the young scientist refused to give up');
    expect(r.status).toBe(200);
    expect(r.body.reading!.hits).toBe(r.body.reading!.total);

    const m = await pool.query<{ body_enc: Buffer | null }>(
      `SELECT body_enc FROM message WHERE session_id = $1`, [sessionId]);
    expect(m.rows).toHaveLength(2);
    for (const row of m.rows) expect(row.body_enc).toBeNull();

    const s = await pool.query<{ read_attempts: number; read_hits: number }>(
      `SELECT read_attempts, read_hits FROM session WHERE id = $1`, [sessionId]);
    expect(s.rows[0]!.read_attempts).toBe(1);
    expect(s.rows[0]!.read_hits).toBeGreaterThan(0);
  });
});
