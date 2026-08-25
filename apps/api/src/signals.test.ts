/**
 * Signal capture, end to end through real turns.
 *
 * Two kinds of assertion here, and the first kind matters more.
 *
 * NEGATIVE: an ordinary turn, a maths turn and a crisis turn capture NOTHING.
 * Capture is for what the runtime saw go wrong and can name; a row appearing
 * after a good answer would mean the abstractor is running over turns nobody
 * asked it to, which is a quiet expansion of what this system stores about
 * children.
 *
 * THE GATE: docs/chittu-model-plan.md makes phase 2 conditional on "an
 * independent reviewer tries to reconstruct a child sentence from a shape and
 * fails". The last two tests are that, written down: drive twenty-five sessions
 * of a sentence stuffed with a name, a town, a pet, a rare word and a phone
 * number, then grep every text column in the database for any of it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, shapeHash, type DbPool } from '@chittu/db';
import { abstractShape } from '@chittu/safety-kernel';
import { buildServer } from './server.js';
import type { ProviderRouter } from './providers.js';
import type { FastifyInstance } from 'fastify';

const keys = localKeyProvider(randomBytes(32), 'dev');
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => { fixture = await createTestDb(); pool = fixture.pool; }, 120_000);
afterAll(async () => { await fixture?.close(); });
/**
 * SCOPED TO THIS FILE'S OWN SHAPES, never `DELETE FROM signal_counter`.
 *
 * Under PGlite every test file gets its own in-process database, so a global
 * delete here is invisible. Against the real-Postgres lane all 41 files share
 * one database and run concurrently — so a global delete truncates whatever
 * `packages/db/src/signal-repo.test.ts` is halfway through, and that file fails
 * at collection with all 32 of its tests skipped. Intermittently, which is the
 * worst kind: it passed on the retry.
 */
async function forget(text: string) {
  const shape = abstractShape(text);
  if (shape === null) return;
  const h = shapeHash(shape, await keys.indexKey());
  await pool.query('DELETE FROM signal_contributor WHERE shape_hash = $1', [h]);
  await pool.query(
    'DELETE FROM training_signal WHERE shape_hash = $1', [h]);
  await pool.query('DELETE FROM signal_counter WHERE shape_hash = $1', [h]);
}

/** The counter for ONE turn's shape. Counting every row reads another file's. */
async function counterFor(text: string) {
  const shape = abstractShape(text);
  if (shape === null) return null;
  const h = shapeHash(shape, await keys.indexKey());
  const { rows } = await pool.query<{
    k_sessions: number; sightings: number; shape: string | null;
    observed_layer: string; observed_token: string; failure_class: string | null;
    band: string; country: string;
  }>(`SELECT k_sessions, sightings, shape, observed_layer::text AS observed_layer,
             observed_token, failure_class::text AS failure_class, band::text AS band,
             country::text AS country
        FROM signal_counter WHERE shape_hash = $1`, [h]);
  return rows[0] ?? null;
}

/** A router that answers normally unless told to fail in a specific way. */
function router(opts: { classify?: 'fail'; generate?: string } = {}): ProviderRouter {
  return {
    route: (c) => ({
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: `${c}-v1`,
    }),
    async classify() {
      if (opts.classify === 'fail') throw new Error('provider down');
      return { label: 'SAFE', memory: null, assist: null };
    },
    async generate() {
      return opts.generate ?? 'Sunlight scatters! [CHIPS]More[/CHIPS]';
    },
  };
}

async function open_(app: FastifyInstance) {
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: { parentName: 'P', parentEmail: `s-${randomUUID()}@example.com`,
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

/** One fresh family, one turn, torn down. Each call is a distinct session. */
async function turn(text: string, opts: Parameters<typeof router>[0] = {}) {
  const app = await buildServer({ pool, keys, router: router(opts), rateLimitMax: 100_000 });
  const { cookies, sessionId } = await open_(app);
  const res = await app.inject({
    method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies, payload: { text } });
  await app.close();
  return res;
}



// ---------------------------------------------------------------------------

describe('what is NOT captured', () => {
  it.each([
    ['a good answer', 'why is the sky blue'],
    ['a MATHS turn', 'what is 7 times 8'],
    ['a CRISIS turn — L1 caught it, which is not a failure', 'i want to hurt myself'],
  ])('%s captures nothing', async (_label, text) => {
    await forget(text);
    await turn(text);
    expect(await counterFor(text), `${text} was abstracted and stored`).toBeNull();
  });
});

describe('what IS captured', () => {
  it('a classifier that could not answer', async () => {
    const text = 'tell me about volcanoes';
    await forget(text);
    await turn(text, { classify: 'fail' });
    const row = (await counterFor(text))!;
    expect({
      observed_layer: row.observed_layer, failure_class: row.failure_class,
      k_sessions: row.k_sessions, sightings: row.sightings, shape: row.shape,
      band: row.band, country: row.country,
    }).toEqual({
      observed_layer: 'L2_CLASSIFIER', failure_class: 'CLASSIFIER_PARSE',
      k_sessions: 1, sightings: 1, shape: null, band: 'builder', country: 'IN',
    });
  });

  it('the sandbox catching what L1 and L2 both let through', async () => {
    const text = 'everything feels like a lot lately';
    await forget(text);
    await turn(text, { generate: 'CRISIS' });
    const row = await counterFor(text);
    expect({
      observed_layer: row!.observed_layer, observed_token: row!.observed_token,
      failure_class: row!.failure_class,
    }).toEqual({
      observed_layer: 'L5_SANDBOX', observed_token: 'CRISIS',
      // Null on purpose: naming the failure class means deciding that L1 and L2
      // were wrong, and that is a person's call at triage.
      failure_class: null,
    });
  });

  it('the output filter firing', async () => {
    const text = 'do you think about me';
    await forget(text);
    await turn(text, { generate: 'I will always miss you when you go' });
    expect((await counterFor(text))!.failure_class).toBe('L6_CATCH');
  });
});

describe('THE GATE — nothing reconstructable reaches the database', () => {
  /**
   * Everything a child could put in one sentence that would narrow them down —
   * a breed, a pet's name, a small town, a rare diagnosis and an age.
   *
   * NO PHONE NUMBER, and that is worth saying rather than hiding: `\d{10}` is
   * an L1 PII pattern, so a turn containing one never reaches a model and never
   * reaches this code at all. The test below asserts that separately. The
   * abstractor's own handling of phone numbers is covered where it belongs, in
   * packages/safety-kernel.
   */
  const LOADED = 'my labrador Rusty in Thoothukudi has dermatomyositis and is 7 years old';
  const NEEDLES = ['labrador', 'Rusty', 'rusty', 'Thoothukudi', 'thoothukudi',
    'dermatomyositis', 'dermato'];

  /**
   * Every PLAINTEXT column of every table, not the ones we thought of.
   *
   * The word plaintext is doing work. A child's turn is stored in
   * `message.body_enc`, which is bytea, so this sweep cannot see it and is not
   * claiming to — that column's guarantee is the crypto-shred, and it is tested
   * elsewhere. What this proves is narrower and is the thing signal capture
   * could plausibly get wrong: that abstracting a turn did not write any part
   * of it somewhere readable.
   *
   * A sweep that finds nothing looks identical to a sweep that is looking in
   * the wrong place, so `positiveControl` below proves it can find something.
   */
  async function grepEverything(needles: readonly string[]) {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema()
          AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text','character varying')`);
    expect(cols.rows.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const c of cols.rows) {
      for (const n of needles) {
        const r = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${c.table_name}
            WHERE ${c.column_name} IS NOT NULL AND ${c.column_name} LIKE $1`, [`%${n}%`]);
        if (r.rows[0]!.n !== '0') hits.push(`${c.table_name}.${c.column_name} ~ ${n}`);
      }
    }
    return hits;
  }

  it('the sweep can actually find things — positive control', async () => {
    // Three of this repo's instruments have reported success while measuring
    // something else (CLAUDE.md, "never write a test phrase by reading the
    // pattern it tests"). An all-clear from a sweep that reaches no rows is
    // the same failure in a new costume, so: store a turn, then find a value
    // this sweep MUST see.
    await turn('why is the sky blue');
    const hits = await grepEverything(['chat']);
    // Named loosely because `message` is partitioned by month, so the hit lands
    // on `message_2026_08.mode` and the table name moves with the calendar.
    expect(hits.filter((h) => h.includes('.mode ~ chat')),
      'the sweep found nothing at all — it is not reaching any rows').not.toEqual([]);
  });

  it('never sees a phone number at all — L1 stops that turn two layers earlier', async () => {
    const text = 'call me on 9876543210';
    await forget(text);
    await turn(text, { classify: 'fail' });
    expect(await counterFor(text)).toBeNull();
    expect(await grepEverything(['9876543210'])).toEqual([]);
  });

  it('holds nothing readable at 24 sessions, and no shape either', async () => {
    await forget(LOADED);
    for (let i = 0; i < 24; i += 1) await turn(LOADED, { classify: 'fail' });
    const row = (await counterFor(LOADED))!;
    expect(row.k_sessions).toBe(24);
    expect(row.shape, 'a shape was stored below the floor').toBeNull();
    expect(await grepEverything(NEEDLES)).toEqual([]);
  }, 180_000);

  it('at 25 the shape appears, and carries none of the child', async () => {
    await forget(LOADED);
    for (let i = 0; i < 25; i += 1) await turn(LOADED, { classify: 'fail' });
    const row = (await counterFor(LOADED))!;
    expect(row.k_sessions).toBe(25);
    expect(row.shape).not.toBeNull();
    // The pet, the town, the diagnosis and the number are all gone; what is
    // left is the fact that a child said something with a pet and a number in
    // it while the classifier was down. That is the whole trade.
    expect(row.shape).toBe('my <PET> in <OOV> has <OOV> and is <NUM> years old');
    expect(await grepEverything(NEEDLES)).toEqual([]);
  }, 180_000);
});
