/**
 * The k-anonymity floor, exercised against a real Postgres.
 *
 * The headline test is `a shape seen 24 times leaves nothing readable in the
 * database` — it greps EVERY text column of both tables for a distinctive word
 * and expects nothing, which is the property phase 2's gate is written around.
 * The others check that the counting is right, because a floor that is easy to
 * reach is not a floor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './testing.js';
import {
  K_FLOOR, contributorToken, shapeHash, signalRepo,
} from './signal-repo.js';
import { fingerprint } from './crypto.js';

let db: TestDb;
const KEY = randomBytes(32);
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

const SHAPE = 'my <PET> died and i feel <EMOTION>';

const obs = (over: Partial<Parameters<typeof signalRepo.observe>[1]> = {}) => ({
  shape: SHAPE, layer: 'L5_SANDBOX', observedToken: 'CRISIS',
  failureClass: null, band: 'builder', country: 'IN', ...over,
});

/** Fresh shape per test, so counts never bleed between them. */
const uniqueShape = (n: number) => `${SHAPE} ${'<OOV> '.repeat(n).trim()}`;

// ---------------------------------------------------------------------------

describe('shapeHash', () => {
  it('is keyed, not a bare digest', () => {
    // A shape is drawn from a ~2,000-word closed vocabulary, which is close to
    // the friendliest search space an attacker could ask for. An unkeyed hash
    // of one is a plaintext shape in all but name.
    expect(shapeHash(SHAPE, KEY).equals(shapeHash(SHAPE, randomBytes(32)))).toBe(false);
  });

  it('differs from the blind index over the same value — domain separation', () => {
    // Both are HMACs under the same key. Without the tag they would be equal,
    // and anyone holding the index key could match a shape against the
    // fingerprints of memories and emails.
    //
    // THE SHAPE HERE HAS NO PLACEHOLDERS ON PURPOSE. `fingerprint` lowercases
    // its input, so any shape containing `<PET>` hashes a different string and
    // the two values differ whether or not the domain tag is there — a test
    // that passes for a reason that has nothing to do with what it is checking.
    // Removing the tag left this green until the shape was changed.
    const plain = 'i am really tired today';
    expect(plain).toBe(plain.trim().toLowerCase());
    expect(shapeHash(plain, KEY).equals(fingerprint(plain, KEY))).toBe(false);
  });
});

describe('contributorToken', () => {
  const h = shapeHash(SHAPE, KEY);

  it('is stable for one session and one shape', () => {
    const s = randomUUID();
    expect(contributorToken(h, s, KEY).equals(contributorToken(h, s, KEY))).toBe(true);
  });

  it('gives one session UNRELATED tokens for different shapes', () => {
    // The whole point. If a session's token were the same across shapes, these
    // rows would join into "the list of shapes this child produced" — the
    // profile the floor exists to prevent building.
    const s = randomUUID();
    const other = shapeHash('i am <NUM> years old', KEY);
    expect(contributorToken(h, s, KEY).equals(contributorToken(other, s, KEY))).toBe(false);
  });
});

describe('the floor', () => {
  it('holds no readable text at 24 distinct sessions', async () => {
    const shape = uniqueShape(1);
    for (let i = 0; i < K_FLOOR - 1; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
    const h = shapeHash(shape, KEY);
    const r = await db.pool.query<{ shape: string | null; k_sessions: number }>(
      `SELECT shape, k_sessions FROM signal_counter WHERE shape_hash = $1`, [h]);
    expect(r.rows[0]!.k_sessions).toBe(24);
    expect(r.rows[0]!.shape).toBeNull();
  });

  it('writes the shape on the turn that reaches 25, and not before', async () => {
    const shape = uniqueShape(2);
    const h = shapeHash(shape, KEY);
    let crossed = 0;
    for (let i = 0; i < K_FLOOR; i += 1) {
      const out = await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
      if (out.reachedFloor) crossed = i + 1;
    }
    expect(crossed).toBe(K_FLOOR);
    const r = await db.pool.query<{ shape: string | null }>(
      `SELECT shape FROM signal_counter WHERE shape_hash = $1`, [h]);
    expect(r.rows[0]!.shape).toBe(shape);
  });

  it('counts SESSIONS, not turns — one child saying it fifty times is one', async () => {
    const shape = uniqueShape(3);
    const one = randomUUID();
    for (let i = 0; i < 50; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), one, KEY);
    }
    const r = await db.pool.query<{ k_sessions: number; sightings: number; shape: string | null }>(
      `SELECT k_sessions, sightings, shape FROM signal_counter WHERE shape_hash = $1`,
      [shapeHash(shape, KEY)]);
    expect(r.rows[0]!.k_sessions).toBe(1);
    expect(r.rows[0]!.sightings).toBe(50);
    expect(r.rows[0]!.shape).toBeNull();
  });

  it('stops collecting contributors once a shape has promoted', async () => {
    const shape = uniqueShape(4);
    for (let i = 0; i < K_FLOOR; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
    await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    const r = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signal_contributor WHERE shape_hash = $1`,
      [shapeHash(shape, KEY)]);
    // Deleted at the floor and never re-collected, so this table holds at most
    // K_FLOOR rows per shape and shrinks as shapes promote.
    expect(r.rows[0]!.n).toBe('0');
  });
});

describe('THE property — a sub-floor shape is not in the database at all', () => {
  it('leaves no trace of a distinctive shape after 24 sessions', async () => {
    // A shape distinctive enough that finding it anywhere is unambiguous.
    const shape = 'i want to be a <OOV> when i grow up and live in <PLACE>';
    for (let i = 0; i < K_FLOOR - 1; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
    // Every text column of both tables, not the ones we remembered to check.
    const cols = await db.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('signal_counter','signal_contributor')
          AND data_type IN ('text','character varying')`);
    expect(cols.rows.length).toBeGreaterThan(0);
    for (const c of cols.rows) {
      const hit = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${c.table_name}
          WHERE ${c.column_name} IS NOT NULL AND ${c.column_name} LIKE '%grow up%'`);
      expect(hit.rows[0]!.n, `${c.table_name}.${c.column_name} held the shape`).toBe('0');
    }
  });
});

describe('promotion', () => {
  const promotable = async (n: number) => {
    const shape = uniqueShape(n);
    for (let i = 0; i < K_FLOOR; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
    return shapeHash(shape, KEY);
  };

  it('refuses below the floor, in words', async () => {
    const shape = uniqueShape(6);
    await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    await expect(signalRepo.promote(db.pool, shapeHash(shape, KEY), {
      failureClass: 'UNDER_REFUSAL', observedLayer: 'L5_SANDBOX', expectedToken: 'CRISIS',
    })).rejects.toThrow(/below the k-anonymity floor: 1 of 25/);
  });

  it('writes a training_signal carrying the human judgement', async () => {
    const h = await promotable(9);
    const id = await signalRepo.promote(db.pool, h, {
      failureClass: 'UNDER_REFUSAL', observedLayer: 'L5_SANDBOX', expectedToken: 'CRISIS',
    });
    const r = await db.pool.query<{
      failure_class: string; expected_token: string; k_sessions: number; state: string;
    }>(`SELECT failure_class, expected_token, k_sessions, state
          FROM training_signal WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({
      failure_class: 'UNDER_REFUSAL', expected_token: 'CRISIS',
      k_sessions: K_FLOOR, state: 'PENDING_HUMAN_REVIEW',
    });
  });

  it('refuses to promote the same shape twice', async () => {
    const h = await promotable(10);
    await signalRepo.promote(db.pool, h, {
      failureClass: 'L6_CATCH', observedLayer: 'L6_FILTER', expectedToken: null,
    });
    await expect(signalRepo.promote(db.pool, h, {
      failureClass: 'L6_CATCH', observedLayer: 'L6_FILTER', expectedToken: null,
    })).rejects.toThrow(/already promoted/);
  });
});

describe('facets are kept only while every sighting agrees', () => {
  it('keeps a band that never varies', async () => {
    const shape = uniqueShape(7);
    for (let i = 0; i < 3; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape, band: 'explorer' }), randomUUID(), KEY);
    }
    const r = await db.pool.query<{ band: string | null }>(
      `SELECT band FROM signal_counter WHERE shape_hash = $1`, [shapeHash(shape, KEY)]);
    expect(r.rows[0]!.band).toBe('explorer');
  });

  it('drops it for good the first time one disagrees', async () => {
    // Recording the FIRST band would read as "this is an explorer thing" when
    // all it means is that an explorer got there first.
    const shape = uniqueShape(8);
    await signalRepo.observe(db.pool, obs({ shape, band: 'explorer' }), randomUUID(), KEY);
    await signalRepo.observe(db.pool, obs({ shape, band: 'thinker' }), randomUUID(), KEY);
    await signalRepo.observe(db.pool, obs({ shape, band: 'explorer' }), randomUUID(), KEY);
    const r = await db.pool.query<{ band: string | null }>(
      `SELECT band FROM signal_counter WHERE shape_hash = $1`, [shapeHash(shape, KEY)]);
    expect(r.rows[0]!.band).toBeNull();
  });
});
