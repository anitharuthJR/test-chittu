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
import { contentFingerprint, fingerprint } from './crypto.js';

let db: TestDb;
const KEY = randomBytes(32);
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

const SHAPE = 'my <PET> died and i feel <EMOTION>';

const obs = (over: Partial<Parameters<typeof signalRepo.observe>[1]> = {}) => ({
  shape: SHAPE, layer: 'L5_SANDBOX', observedToken: 'CRISIS',
  failureClass: null, band: 'builder', country: 'IN', ...over,
});

/**
 * Fresh shape per test AND per run.
 *
 * The run tag matters on the real-Postgres lane, where the database survives
 * between invocations: without it a second `pnpm test` finds the first run's
 * counters already at the floor and every count assertion is off. It is a
 * lowercase word, which is what `shape_is_abstracted` accepts.
 */
const RUN = `run-${randomUUID().slice(0, 8)}`;
const uniqueShape = (n: number) => `${SHAPE} ${RUN} ${'<OOV> '.repeat(n).trim()}`;

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

// ---------------------------------------------------------------------------

describe('contentFingerprint — the corpus leakage guard', () => {
  it('is unkeyed and reproducible, unlike the blind index', () => {
    // It has to be re-derivable for the life of the corpus: check_leakage.py
    // computes it offline, and a dataset export must answer "was this eval
    // prompt also in train?" years later, after the index key has rotated.
    expect(contentFingerprint('what is 7 plus 5'))
      .toEqual(contentFingerprint('what is 7 plus 5'));
  });

  it('collapses whitespace — a re-typed example is the same example', () => {
    expect(contentFingerprint('i feel  sad   today'))
      .toEqual(contentFingerprint('i feel sad today'));
  });

  it('KEEPS case, unlike fingerprint() — two casings are two examples', () => {
    // fingerprint() lowercases, which is right for an email and wrong here:
    // collapsing them would silently refuse the second as a duplicate.
    expect(contentFingerprint('Rusty died')).not.toEqual(contentFingerprint('rusty died'));
    expect(fingerprint('Rusty died', KEY)).toEqual(fingerprint('rusty died', KEY));
  });

  it('is domain-separated from the blind index', () => {
    const plain = 'i am really tired today';
    expect(contentFingerprint(plain).equals(fingerprint(plain, KEY))).toBe(false);
  });
});

describe('the triage queue', () => {
  const fill = async (shape: string, n: number) => {
    for (let i = 0; i < n; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
  };

  it('shows only shapes that reached the floor', async () => {
    await fill(uniqueShape(20), K_FLOOR);      // ready
    await fill(uniqueShape(21), K_FLOOR - 1);  // not
    const ready = await signalRepo.listReady(db.pool);
    expect(ready.map((r) => r.shape)).toContain(uniqueShape(20));
    expect(ready.map((r) => r.shape)).not.toContain(uniqueShape(21));
  });

  it('lists NOTHING about a sub-floor shape — not even its facets', async () => {
    // At k=1 the row already carries band, country, observed_token and
    // first_seen_at, all written on the first sighting. That is one child's
    // turn described in facets and timestamped to the second. So the read path
    // filters, and it filters on shape IS NOT NULL rather than on a count that
    // somebody could get wrong.
    await fill(uniqueShape(22), 1);
    const ready = await signalRepo.listReady(db.pool);
    const handles = ready.map((r) => r.handle);
    expect(handles).not.toContain(shapeHash(uniqueShape(22), KEY).toString('hex'));
  });

  it('ranks by SIGHTINGS, because k_sessions freezes at the floor', async () => {
    // The trap this test exists for: k_sessions stops counting once the shape
    // is stored, so every readable row reads exactly 25 and a queue ordered by
    // it is ordered by a constant.
    const quiet = uniqueShape(23);
    const loud = uniqueShape(24);
    await fill(quiet, K_FLOOR + 1);
    await fill(loud, K_FLOOR + 40);
    const ready = await signalRepo.listReady(db.pool);
    const idx = (s: string) => ready.findIndex((r) => r.shape === s);
    expect(idx(loud)).toBeLessThan(idx(quiet));
    // And the assertion that stops this passing on the wrong column:
    const both = ready.filter((r) => r.shape === loud || r.shape === quiet);
    expect(both.map((r) => r.k_sessions)).toEqual([K_FLOOR, K_FLOOR]);
    expect(both.map((r) => r.sightings)).not.toEqual([K_FLOOR, K_FLOOR]);
  });

  it('counts sub-floor shapes as ONE number and never lists them', async () => {
    const before = await signalRepo.subFloorCount(db.pool);
    await fill(uniqueShape(25), 3);
    expect(await signalRepo.subFloorCount(db.pool)).toBe(before + 1);
  });

  it('drops a shape off the queue once it is promoted', async () => {
    const shape = uniqueShape(26);
    await fill(shape, K_FLOOR);
    await signalRepo.promote(db.pool, shapeHash(shape, KEY), {
      failureClass: 'UNDER_REFUSAL', expectedToken: 'CRISIS',
    });
    expect((await signalRepo.listReady(db.pool)).map((r) => r.shape)).not.toContain(shape);
  });
});

describe('promotion takes the OBSERVATION from the row', () => {
  it('uses the layer the pipeline saw, not the one the operator typed', async () => {
    const shape = uniqueShape(27);
    for (let i = 0; i < K_FLOOR; i += 1) {
      await signalRepo.observe(
        db.pool, obs({ shape, layer: 'L6_FILTER' }), randomUUID(), KEY);
    }
    const id = await signalRepo.promote(db.pool, shapeHash(shape, KEY), {
      failureClass: 'L6_CATCH', expectedToken: null, observedLayer: 'L2_CLASSIFIER',
    });
    const { rows } = await db.pool.query<{ observed_layer: string }>(
      `SELECT observed_layer FROM training_signal WHERE id = $1`, [id]);
    expect(rows[0]!.observed_layer, 'the operator overwrote what the pipeline saw')
      .toBe('L6_FILTER');
  });

  it('refuses, in words, when the row itself is undecided', async () => {
    // observed_layer goes NULL when two sightings disagreed. training_signal's
    // is NOT NULL, so somebody has to choose — and refusing beats inventing.
    const shape = uniqueShape(28);
    await signalRepo.observe(db.pool, obs({ shape, layer: 'L6_FILTER' }), randomUUID(), KEY);
    for (let i = 0; i < K_FLOOR - 1; i += 1) {
      await signalRepo.observe(
        db.pool, obs({ shape, layer: 'L2_CLASSIFIER' }), randomUUID(), KEY);
    }
    await expect(signalRepo.promote(db.pool, shapeHash(shape, KEY), {
      failureClass: 'L6_CATCH', expectedToken: null,
    })).rejects.toThrow(/observed at more than one layer/);
  });
});

describe('authoring an example', () => {
  const promoted = async (n: number) => {
    const shape = uniqueShape(n);
    for (let i = 0; i < K_FLOOR; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
    return signalRepo.promote(db.pool, shapeHash(shape, KEY), {
      failureClass: 'UNDER_REFUSAL', expectedToken: 'CRISIS',
    });
  };

  const example = (over: Record<string, unknown> = {}) => ({
    signalId: '', slice: 'grief', prompt: 'my dog died and i feel empty',
    completion: 'That sounds really hard. Would you tell a grown-up you trust?',
    label: 'SAFE', split: 'train', authoredBy: 'ada@tulifo.ai', ...over,
  });

  it('writes AUTHORED and PENDING_HUMAN_REVIEW, whatever the caller wanted', async () => {
    const signalId = await promoted(30);
    const id = await signalRepo.authorExample(db.pool, example({ signalId }) as never);
    const { rows } = await db.pool.query<{ origin: string; state: string; authored_by: string }>(
      `SELECT origin::text AS origin, state::text AS state, authored_by
         FROM training_example WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({
      origin: 'AUTHORED', state: 'PENDING_HUMAN_REVIEW', authored_by: 'ada@tulifo.ai',
    });
  });

  it('refuses a duplicate prompt with a sentence, not a database error', async () => {
    const signalId = await promoted(31);
    const prompt = 'i keep thinking about it and i cannot stop';
    await signalRepo.authorExample(db.pool, example({ signalId, prompt }) as never);
    await expect(
      signalRepo.authorExample(db.pool, example({
        signalId, prompt, split: 'eval_holdout', completion: 'different answer',
      }) as never)).rejects.toThrow(/already in the corpus/);
  });

  it('the leak guard is CROSS-SPLIT — that is the whole point of it', async () => {
    // An eval prompt that also sits in train invalidates every scorecard since
    // it landed. It happened here for four rounds before check_leakage.py.
    const signalId = await promoted(32);
    const prompt = 'what is photosynthesis';
    await signalRepo.authorExample(
      db.pool, example({ signalId, prompt, split: 'train' }) as never);
    await expect(signalRepo.authorExample(
      db.pool, example({ signalId, prompt, split: 'eval_holdout' }) as never))
      .rejects.toThrow(/already in the corpus/);
  });

  it('refuses a label outside the five tokens', async () => {
    const signalId = await promoted(33);
    await expect(signalRepo.authorExample(
      db.pool, example({ signalId, label: 'MAYBE', prompt: 'x y z' }) as never))
      .rejects.toThrow(/label_vocab/i);
  });
});

describe('four eyes', () => {
  const authored = async (n: number, by: string) => {
    const shape = uniqueShape(n);
    for (let i = 0; i < K_FLOOR; i += 1) {
      await signalRepo.observe(db.pool, obs({ shape }), randomUUID(), KEY);
    }
    const signalId = await signalRepo.promote(db.pool, shapeHash(shape, KEY), {
      failureClass: 'UNDER_REFUSAL', expectedToken: 'CRISIS',
    });
    return signalRepo.authorExample(db.pool, {
      signalId, slice: 'grief', prompt: `prompt number ${n}`,
      completion: 'a careful answer', label: 'SAFE', split: 'train', authoredBy: by,
    });
  };

  it('refuses the author approving their own row', async () => {
    const id = await authored(40, 'ada@tulifo.ai');
    await expect(signalRepo.reviewExample(
      db.pool, id, { state: 'APPROVED', reviewedBy: 'ada@tulifo.ai' }))
      .rejects.toThrow(/second pair of eyes/);
  });

  it('refuses them under a different casing or a stray space', async () => {
    // The CHECK compares raw strings, so ' Ada@Tulifo.ai ' and 'ada@tulifo.ai'
    // are two people to the database and one person to everybody else — four
    // eyes that are the same two.
    const id = await authored(41, 'ada@tulifo.ai');
    await expect(signalRepo.reviewExample(
      db.pool, id, { state: 'APPROVED', reviewedBy: ' Ada@Tulifo.ai ' }))
      .rejects.toThrow(/second pair of eyes/);
  });

  it('accepts a genuinely different person', async () => {
    const id = await authored(42, 'ada@tulifo.ai');
    await signalRepo.reviewExample(
      db.pool, id, { state: 'APPROVED', reviewedBy: 'grace@tulifo.ai' });
    const { rows } = await db.pool.query<{ state: string; reviewed_by: string }>(
      `SELECT state::text AS state, reviewed_by FROM training_example WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ state: 'APPROVED', reviewed_by: 'grace@tulifo.ai' });
  });
});
