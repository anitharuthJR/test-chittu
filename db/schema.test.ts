/**
 * The schema's safety invariants, as executable tests.
 *
 * `chittu-schema.sql` claims that doctrine is enforced by CONSTRAINTS rather than
 * convention. That is only worth saying if it is checked, so this file tries to
 * violate each invariant and asserts the database refuses.
 *
 * Runs on PGlite — real Postgres compiled to WASM — so no server is needed and
 * this can gate CI. pgvector has no PGlite build, so the two vector-specific
 * statements are shimmed out and remain unverified here; everything else is the
 * genuine article.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from '../packages/db/src/testing';

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let db: { query: <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
  Promise<{ rows: R[] }>; };

/** parent.email_hash is UNIQUE, so each fixture needs its own. */
let fixtureSeq = 0;

/** Every fixture needs a parent -> child -> consent -> session spine. */
async function seedFamily(env: 'dev' | 'prod' = 'dev') {
  // bytea goes in as a literal, not a bound parameter: PGlite binds bytea from a
  // Uint8Array and rejects a hex string, which reads as "Invalid input for bytea type".
  const uniq = `\\x${(++fixtureSeq).toString(16).padStart(8, '0')}`;
  await db.query(`DELETE FROM deployment`);
  await db.query(
    `INSERT INTO deployment (env, region) VALUES ($1, 'ap-south-1')`, [env]);
  const p = await db.query<{ id: string }>(
    `INSERT INTO parent (email_hash, email_enc) VALUES ('${uniq}', '\\x02') RETURNING id`);
  const parentId = p.rows[0]!.id;
  const c = await db.query<{ id: string }>(
    `INSERT INTO child (parent_id, first_name_enc, band, country)
     VALUES ($1, '\\x03', 'builder', 'IN') RETURNING id`, [parentId]);
  const childId = c.rows[0]!.id;
  const cr = await db.query<{ id: string }>(
    `INSERT INTO consent_record (parent_id, child_id, jurisdiction, law, method, status,
                                 band, board, seal_hash, issued_at)
     VALUES ($1, $2, 'IN', 'DPDP 2023', 'gov_id_review', 'active', 'builder', 'CBSE', 'h', now())
     RETURNING id`, [parentId, childId]);
  const consentId = cr.rows[0]!.id;
  const s = await db.query<{ id: string }>(
    `INSERT INTO session (child_id, consent_id, band) VALUES ($1, $2, 'builder') RETURNING id`,
    [childId, consentId]);
  return { parentId, childId, consentId, sessionId: s.rows[0]!.id };
}

/** Assert a statement is rejected, and optionally that the message names the reason. */
async function rejects(sql: string, params: unknown[] = [], matching?: RegExp) {
  let err: Error | null = null;
  try { await db.query(sql, params); } catch (e) { err = e as Error; }
  expect(err, `expected the database to REFUSE:\n${sql}`).not.toBeNull();
  if (matching) expect(err!.message).toMatch(matching);
}

beforeAll(async () => {
  fixture = await createTestDb();
  db = fixture.pool;
}, 180_000);

afterAll(async () => { await fixture.close(); });

// ---------------------------------------------------------------------------

describe('invariant 1 — a flag can never hold a child’s words', () => {
  it('has no free-text column at all on flag', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'flag' AND data_type IN ('text','character varying')`);
    // note_key and assist_topic are the only text columns, and both are constrained
    expect(r.rows.map((x) => x.column_name).sort()).toEqual(['assist_topic', 'note_key']);
  });

  it('refuses a note_key that is not vetted wording', async () => {
    const { childId } = await seedFamily();
    await rejects(
      `INSERT INTO flag (child_id, kind, note_key) VALUES ($1, 'SAFETY', 'the child said she wants to die')`,
      [childId], /foreign key|violates/i);
  });

  it('refuses a quoted sentence smuggled through assist_topic', async () => {
    const { childId } = await seedFamily();
    await rejects(
      `INSERT INTO flag (child_id, kind, note_key, assist_topic)
       VALUES ($1, 'ASSIST', 'STRUGGLE_TOPIC', 'my dad shouts at me when I get sums wrong')`,
      [childId], /assist_topic|check/i);
  });

  it('accepts a vetted flag with a bare school topic', async () => {
    const { childId } = await seedFamily();
    const r = await db.query(
      `INSERT INTO flag (child_id, kind, note_key, assist_topic)
       VALUES ($1, 'ASSIST', 'STRUGGLE_TOPIC', 'fractions') RETURNING id`, [childId]);
    expect(r.rows).toHaveLength(1);
  });
});

describe('invariant 2 — a memory can never leave the allowlist', () => {
  it('permits exactly the six allowlisted categories', async () => {
    const r = await db.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::memory_category))::text AS v`);
    expect(r.rows.map((x) => x.v).sort()).toEqual(
      ['ACHIEVEMENT', 'FAVORITE', 'HOBBY', 'INTEREST', 'LEARNING', 'PET']);
  });

  it.each(['FEELING', 'HEALTH', 'FAMILY', 'FEAR'])(
    'refuses the forbidden category %s', async (cat) => {
      const { childId } = await seedFamily();
      await rejects(
        `INSERT INTO memory (child_id, category, fact_enc, fact_fingerprint)
         VALUES ($1, '${cat}', '\\x01', '\\x02')`, [childId], /invalid input value|enum/i);
    });
});

describe('invariant 3 — a teen’s message body can never be stored', () => {
  it('refuses a body for band=thinker', async () => {
    const { sessionId } = await seedFamily();
    await rejects(
      `INSERT INTO message (session_id, seq, role, band, body_enc, expires_at)
       VALUES ($1, 1, 'child', 'thinker', '\\xdeadbeef', now() + interval '30 days')`,
      [sessionId], /teen_bodies_are_never_stored/i);
  });

  it('allows a teen turn with topic only', async () => {
    const { sessionId } = await seedFamily();
    const r = await db.query(
      `INSERT INTO message (session_id, seq, role, band, topic, expires_at)
       VALUES ($1, 2, 'child', 'thinker', 'volcanoes', now() + interval '30 days') RETURNING id`,
      [sessionId]);
    expect(r.rows).toHaveLength(1);
  });

  it('still allows a body for younger bands, which the parent view needs', async () => {
    const { sessionId } = await seedFamily();
    const r = await db.query(
      `INSERT INTO message (session_id, seq, role, band, body_enc, expires_at)
       VALUES ($1, 3, 'child', 'builder', '\\xdeadbeef', now() + interval '30 days') RETURNING id`,
      [sessionId]);
    expect(r.rows).toHaveLength(1);
  });
});

describe('invariant 4 — the audit chain can never be edited', () => {
  it('refuses UPDATE', async () => {
    const { sessionId } = await seedFamily();
    await db.query(
      `INSERT INTO audit_event (session_id, seq, role, layer, payload_hash, prev_hash, hash)
       VALUES ($1, 0, 'child', 'SEAL', 'p', 'GENESIS', 'h1')`, [sessionId]);
    await rejects(`UPDATE audit_event SET payload_hash = 'tampered'`, [], /append-only/i);
  });

  it('refuses DELETE', async () => {
    await rejects(`DELETE FROM audit_event`, [], /append-only/i);
  });

  it('refuses a forked chain — two events cannot share a sequence number', async () => {
    const { sessionId } = await seedFamily();
    await db.query(
      `INSERT INTO audit_event (session_id, seq, role, layer, payload_hash, prev_hash, hash)
       VALUES ($1, 0, 'child', 'SEAL', 'p', 'GENESIS', 'fork-a')`, [sessionId]);
    await rejects(
      `INSERT INTO audit_event (session_id, seq, role, layer, payload_hash, prev_hash, hash)
       VALUES ($1, 0, 'child', 'SEAL', 'p', 'GENESIS', 'fork-b')`, [sessionId], /unique|duplicate/i);
  });
});

// ---------------------------------------------------------------------------

describe('consent gates', () => {
  it('refuses DigiLocker while the adapter is deferred', async () => {
    const { parentId, childId } = await seedFamily();
    await rejects(
      `INSERT INTO consent_record (parent_id, child_id, jurisdiction, law, method, band, board, seal_hash)
       VALUES ($1, $2, 'IN', 'DPDP 2023', 'digilocker', 'builder', 'CBSE', 'h')`,
      [parentId, childId], /digilocker_deferred/i);
  });

  it('refuses the dev stub in production', async () => {
    const { parentId, childId } = await seedFamily('prod');
    await rejects(
      `INSERT INTO consent_record (parent_id, child_id, jurisdiction, law, method, band, board, seal_hash)
       VALUES ($1, $2, 'IN', 'DPDP 2023', 'dev_stub', 'builder', 'CBSE', 'h')`,
      [parentId, childId], /dev_stub is not permitted in production/i);
  });

  it('allows the dev stub outside production', async () => {
    const { parentId, childId } = await seedFamily('dev');
    const r = await db.query(
      `INSERT INTO consent_record (parent_id, child_id, jurisdiction, law, method, band, board, seal_hash)
       VALUES ($1, $2, 'IN', 'DPDP 2023', 'dev_stub', 'builder', 'CBSE', 'h') RETURNING id`,
      [parentId, childId]);
    expect(r.rows).toHaveLength(1);
  });

  it('allows only one active consent per child', async () => {
    const { parentId, childId } = await seedFamily();
    await rejects(
      `INSERT INTO consent_record (parent_id, child_id, jurisdiction, law, method, status,
                                   band, board, seal_hash, issued_at)
       VALUES ($1, $2, 'IN', 'DPDP 2023', 'gov_id_review', 'active', 'builder', 'CBSE', 'h', now())`,
      [parentId, childId], /consent_one_active|unique/i);
  });
});

describe('G3 — a market cannot open without somewhere to send a child', () => {
  it('refuses to enable a country with no verified helplines', async () => {
    await rejects(
      `INSERT INTO market (country, enabled) VALUES ('AU', true)`, [],
      /cannot be enabled without verified helplines/i);
  });

  it('allows it once helplines are verified', async () => {
    await db.query(
      `INSERT INTO helpline_registry (country, lines, last_verified, verified_by, next_sweep)
       VALUES ('AU', '[{"name":"Kids Helpline","number":"1800 55 1800"}]'::jsonb,
               now(), 'ops', now() + interval '90 days')`);
    const r = await db.query(`INSERT INTO market (country, enabled) VALUES ('AU', true) RETURNING country`);
    expect(r.rows).toHaveLength(1);
  });

  it('refuses a registry row with an empty helpline list', async () => {
    await rejects(
      `INSERT INTO helpline_registry (country, lines, last_verified, verified_by, next_sweep)
       VALUES ('SG', '[]'::jsonb, now(), 'ops', now())`, [], /lines_not_empty/i);
  });
});

describe('G2 reaches the GPU — a model cannot be promoted without passing', () => {
  it('refuses promotion when g2_passed is false', async () => {
    await rejects(
      `INSERT INTO training_run (base_model, dataset_sha256, example_count, seed,
                                 g2_passed, approved_by, promoted_at)
       VALUES ('qwen3-4b', 'abc', 100, 803, false, 'someone', now())`,
      [], /promotion_requires_g2/i);
  });

  it('refuses promotion with no named approver even when G2 passed', async () => {
    await rejects(
      `INSERT INTO training_run (base_model, dataset_sha256, example_count, seed,
                                 g2_passed, promoted_at)
       VALUES ('qwen3-4b', 'def', 100, 803, true, now())`,
      [], /promotion_requires_g2/i);
  });

  it('allows promotion when G2 passed and a human approved', async () => {
    const r = await db.query(
      `INSERT INTO training_run (base_model, dataset_sha256, example_count, seed,
                                 g2_passed, approved_by, promoted_at)
       VALUES ('qwen3-4b', 'ghi', 100, 803, true, 'safety-eng', now()) RETURNING id`);
    expect(r.rows).toHaveLength(1);
  });
});

describe('training corpus cannot hold a child’s words', () => {
  it('refuses raw prose in a training signal shape', async () => {
    await rejects(
      `INSERT INTO training_signal (shape, shape_hash, observed_layer, failure_class, k_sessions)
       VALUES ('My hamster Barnaby died on Tuesday and I feel empty.', '\\x01',
               'L2_CLASSIFIER', 'OVER_REFUSAL', 40)`,
      [], /shape_is_abstracted/i);
  });

  it('refuses a shape below the k-anonymity floor', async () => {
    await rejects(
      `INSERT INTO training_signal (shape, shape_hash, observed_layer, failure_class, k_sessions)
       VALUES ('my <pet> died and i feel <emotion>', '\\x02',
               'L2_CLASSIFIER', 'OVER_REFUSAL', 24)`,
      [], /k_sessions/i);
  });

  it('accepts an abstracted shape at or above the floor', async () => {
    const r = await db.query(
      `INSERT INTO training_signal (shape, shape_hash, observed_layer, failure_class, k_sessions)
       VALUES ('my <pet> died and i feel <emotion>', '\\x03',
               'L2_CLASSIFIER', 'OVER_REFUSAL', 25) RETURNING id`);
    expect(r.rows).toHaveLength(1);
  });

  it('has no origin value meaning "a real child said this"', async () => {
    const r = await db.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::training_origin))::text AS v`);
    const vals = r.rows.map((x) => x.v);
    expect(vals).not.toContain('CHILD_TURN');
    expect(vals.sort()).toEqual(['AUTHORED', 'DISTILLED', 'RED_TEAM', 'STAFF', 'SYNTHETIC']);
  });

  it('refuses an example reviewed by its own author', async () => {
    await rejects(
      `INSERT INTO training_example (origin, slice, prompt, completion, content_fingerprint,
                                     authored_by, reviewed_by, state)
       VALUES ('AUTHORED', 'grief', 'p', 'c', '\\x10', 'ada', 'ada', 'APPROVED')`,
      [], /four_eyes_authoring/i);
  });

  it('refuses the same content in two splits — the leakage guard', async () => {
    await db.query(
      `INSERT INTO training_example (origin, slice, prompt, completion, content_fingerprint,
                                     authored_by, split)
       VALUES ('AUTHORED', 'crisis', 'vaazhkai venam', 'CRISIS', '\\x20', 'ada', 'train')`);
    await rejects(
      `INSERT INTO training_example (origin, slice, prompt, completion, content_fingerprint,
                                     authored_by, split)
       VALUES ('AUTHORED', 'crisis', 'vaazhkai venam', 'CRISIS', '\\x20', 'grace', 'eval_holdout')`,
      [], /training_example_no_leak|unique|duplicate/i);
  });
});

describe('named-humans access to a transcript', () => {
  it('refuses a self-approved grant', async () => {
    const { childId } = await seedFamily();
    const a = await db.query<{ id: string }>(
      `INSERT INTO admin_user (email, full_name, role) VALUES ('a@t.ai','A','safety') RETURNING id`);
    const id = a.rows[0]!.id;
    await rejects(
      `INSERT INTO transcript_grant (admin_id, child_id, reason, approved_by, expires_at)
       VALUES ($1, $2, 'investigating', $1, now() + interval '1 day')`,
      [id, childId], /four_eyes/i);
  });

  it('refuses a grant that never expires', async () => {
    const { childId } = await seedFamily();
    const rows = await db.query<{ id: string }>(
      `INSERT INTO admin_user (email, full_name, role)
       VALUES ('b@t.ai','B','safety'), ('c@t.ai','C','dpo') RETURNING id`);
    await rejects(
      `INSERT INTO transcript_grant (admin_id, child_id, reason, approved_by, expires_at)
       VALUES ($1, $2, 'investigating', $3, now() - interval '1 day')`,
      [rows.rows[0]!.id, childId, rows.rows[1]!.id], /grant_is_time_boxed/i);
  });
});

describe('revocation actually erases', () => {
  it('shreds the key, drops messages, and leaves the ledger standing as proof', async () => {
    const { childId, sessionId } = await seedFamily();
    await db.query(
      `INSERT INTO child_data_key (child_id, wrapped_dek, kms_key_arn)
       VALUES ($1, '\\xfeedface', 'arn:aws:kms:test')`, [childId]);
    await db.query(
      `INSERT INTO memory (child_id, category, fact_enc, fact_fingerprint)
       VALUES ($1, 'PET', '\\x01', '\\x99')`, [childId]);
    await db.query(
      `INSERT INTO message (session_id, seq, role, band, body_enc, expires_at)
       VALUES ($1, 9, 'child', 'builder', '\\xdead', now() + interval '30 days')`, [sessionId]);

    // SET LOCAL only applies inside a transaction — outside one it is a no-op,
    // and revoke_and_erase now refuses an unscoped call.
    await fixture.pool.transaction(async (tx) => {
      await tx.query(`SET LOCAL chittu.child_id = '${childId}'`);
      await tx.query(`SELECT revoke_and_erase($1, 'parent request')`, [childId]);
    });

    const key = await db.query<{ wrapped_dek: unknown; shredded_at: string | null }>(
      `SELECT wrapped_dek, shredded_at FROM child_data_key WHERE child_id = $1`, [childId]);
    expect(key.rows[0]!.shredded_at).not.toBeNull();

    const msgs = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM message WHERE session_id = $1`, [sessionId]);
    expect(msgs.rows[0]!.n).toBe(0);

    const mem = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM memory WHERE child_id = $1 AND deleted_at IS NULL`, [childId]);
    expect(mem.rows[0]!.n).toBe(0);

    // the consent row SURVIVES — it is the proof a consent existed and was withdrawn
    const consent = await db.query<{ status: string }>(
      `SELECT status FROM consent_record WHERE child_id = $1`, [childId]);
    expect(consent.rows.map((r) => r.status)).toContain('revoked');
  });

  it('refuses to erase the wrong child when the request is scoped to another', async () => {
    const a = await seedFamily();
    const b = await seedFamily();
    // a silent no-op on an erasure request is the worst failure this system has
    let err: Error | null = null;
    try {
      await fixture.pool.transaction(async (tx) => {
        await tx.query(`SET LOCAL chittu.child_id = '${a.childId}'`);
        await tx.query(`SELECT revoke_and_erase($1, 'wrong scope')`, [b.childId]);
      });
    } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/under a session scoped to/i);
  });

  it('refuses an unscoped erase rather than silently erasing nothing', async () => {
    const { childId } = await seedFamily();
    // an earlier transaction leaves the key set to '' rather than unset
    await db.query(`SELECT set_config('chittu.child_id', '', false)`);
    await rejects(`SELECT revoke_and_erase($1, 'no scope set')`, [childId],
      /requires chittu.child_id to be set/i);
  });
});
