/**
 * "The kids stopped talking to it", read from the database.
 *
 * Seat 38's standing condition (council-session-001): treat this as a safety
 * incident too — "the most dangerous thing we could build is something we're
 * proud of and children ignore". @chittu/disengagement does the classifying;
 * this is the only thing that can feed it real sessions.
 *
 * THE TESTS THAT MATTER HERE ARE THE NEGATIVE ONES. A disengagement number is
 * one product decision away from being a retention lever, and Law 04 forbids
 * exactly that. So the query returns cohort data with NO child identifier in it:
 * you cannot build "nudge this child back" on a value that does not say which
 * child. That is enforced below rather than promised in a comment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
import { cohortSignal } from '@chittu/disengagement';
import { engagementRepo } from './engagement-repo.js';

let db: TestDb;
const DAY = 86_400_000;
const now = Date.UTC(2026, 7, 25);
let seedSeq = 0;

/** A child with a given session history. Returns nothing — by design. */
async function seedChild(
  sessions: { daysAgo: number; msgCount: number; spineCount: number; ended: string }[],
) {
  const seq = ++seedSeq;
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO parent (email_hash, email_enc, display_name_enc)
     VALUES ($1, $2, $3) RETURNING id`,
    [Buffer.from(`hash-${seq}`), Buffer.from('e'), Buffer.from('n')],
  );
  const parentId = rows[0]!.id;
  const { rows: ch } = await db.pool.query<{ id: string }>(
    `INSERT INTO child (parent_id, first_name_enc, band, board, country)
     VALUES ($1, $2, 'explorer', 'General', 'IN') RETURNING id`,
    [parentId, Buffer.from('c')],
  );
  const childId = ch[0]!.id;
  const { rows: cr } = await db.pool.query<{ id: string }>(
    `INSERT INTO consent_record
       (parent_id, child_id, version, jurisdiction, law, method, status,
        issued_at, scopes, memory_on, learn_on, band, board, seal_hash)
     VALUES ($1,$2,1,'IN','DPDP','dev_stub','active',
             now(), '["chat"]'::jsonb, true, false, 'explorer', 'General', 'seed')
     RETURNING id`,
    [parentId, childId],
  );
  const consentId = cr[0]!.id;

  for (const s of sessions) {
    const started = new Date(now - s.daysAgo * DAY);
    await db.pool.query(
      `INSERT INTO session (child_id, consent_id, band, started_at, ended_at,
                            ended_reason, msg_count, spine_count)
       VALUES ($1,$2,'explorer',$3,$4,$5,$6,$7)`,
      [childId, consentId, started, new Date(started.getTime() + 600_000),
       s.ended, s.msgCount, s.spineCount],
    );
  }
  return childId;
}

beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

describe('engagementRepo.cohort', () => {
  it('returns one entry per child, each their own sessions', async () => {
    await seedChild([
      { daysAgo: 30, msgCount: 20, spineCount: 0, ended: 'child_left' },
      { daysAgo: 20, msgCount: 18, spineCount: 0, ended: 'child_left' },
      { daysAgo: 10, msgCount: 22, spineCount: 1, ended: 'child_left' },
      { daysAgo: 2, msgCount: 19, spineCount: 0, ended: 'child_left' },
    ]);

    const cohort = await engagementRepo.cohort(db.pool);

    expect(cohort.length).toBe(1);
    expect(cohort[0]!.length).toBe(4);
    // Newest last, because classifyChild reads cadence from the ordering.
    const starts = cohort[0]!.map((s) => s.startedAt);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('feeds cohortSignal, which is the whole point of it existing', async () => {
    const cohort = await engagementRepo.cohort(db.pool);
    const signal = cohortSignal(cohort, now);
    expect(signal.judged).toBeGreaterThan(0);
    expect(signal.active + signal.graduated + signal.abandoned).toBe(signal.judged);
  });

  it('Law 04 — carries NO child identifier, so nothing can target a child', async () => {
    const cohort = await engagementRepo.cohort(db.pool);
    const serialised = JSON.stringify(cohort);

    // Every field on every session, enumerated. A new field added upstream
    // fails this rather than silently riding along.
    for (const session of cohort.flat()) {
      expect(Object.keys(session).sort()).toEqual(
        ['endedAt', 'endedReason', 'msgCount', 'spineCount', 'startedAt'],
      );
    }
    expect(serialised).not.toMatch(/childId|child_id|sessionId|parentId/i);
    // And no uuid anywhere — the shape above would already catch a named id,
    // this catches one smuggled in as a value.
    expect(serialised).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('reads no child words — the SQL names only metadata columns', async () => {
    // The type already forbids it; this asserts the query text does too, because
    // a `SELECT *` would satisfy the type via structural typing and still pull
    // body_enc and the classifier's rolling window into memory.
    expect(engagementRepo.COHORT_SQL).not.toMatch(/select\s+(\w+\.)?\*/i);
    expect(engagementRepo.COHORT_SQL).not.toMatch(/body_enc|rolling|window|topic|assist/i);
  });

  it('separates two children rather than pooling their sessions', async () => {
    await seedChild([
      { daysAgo: 40, msgCount: 12, spineCount: 0, ended: 'child_left' },
      { daysAgo: 39, msgCount: 3, spineCount: 3, ended: 'child_left' },
      { daysAgo: 38, msgCount: 2, spineCount: 2, ended: 'child_left' },
    ]);

    const cohort = await engagementRepo.cohort(db.pool);
    expect(cohort.length).toBe(2);
    // Pooling would give one entry of 7; the counts prove they stayed apart.
    expect(cohort.map((c) => c.length).sort()).toEqual([3, 4]);
  });

  it('excludes an erased child — crypto-shred means gone, including from a metric', async () => {
    const id = await seedChild([
      { daysAgo: 5, msgCount: 10, spineCount: 0, ended: 'child_left' },
      { daysAgo: 4, msgCount: 10, spineCount: 0, ended: 'child_left' },
      { daysAgo: 3, msgCount: 10, spineCount: 0, ended: 'child_left' },
    ]);
    const before = (await engagementRepo.cohort(db.pool)).length;

    await db.pool.query(`UPDATE child SET deleted_at = now() WHERE id = $1`, [id]);

    const after = await engagementRepo.cohort(db.pool);
    expect(after.length).toBe(before - 1);
  });
});
