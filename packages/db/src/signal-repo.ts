/**
 * Counting shapes, without being able to say who produced one.
 *
 * Architecture §11.2 in one paragraph: what production data is worth is not the
 * child's words, it is knowing which shapes of input the pipeline handles
 * badly. `@chittu/safety-kernel`'s abstractor produces the shape; this counts
 * it; a human decides what it means.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND HERE
 *
 * `observe()` is the only code in the system that writes a shape's TEXT, and it
 * does so on exactly one turn: the one that takes the count from 24 to 25.
 * Below the floor the database holds a keyed hash and an integer — nothing that
 * can be rendered, redacted, subpoenaed or leaked, because nothing was stored.
 * The shape spends the whole time below the floor in the memory of one request.
 *
 * That is a stronger claim than "the application refuses to show shapes below
 * 25", which is the shape of guarantee that survives right up until someone
 * writes a second application.
 *
 * WHY THIS DOES NOT WRITE `training_signal`
 *
 * The schema grants the runtime nothing on the training corpus, and the comment
 * at the end of chittu-schema.sql calls that absence the control. Promotion is
 * `promote()`, called by an operator with different credentials — which is also
 * the honest shape of the thing, because promotion requires a `failure_class`
 * and that is a judgement about what SHOULD have happened.
 */

import { createHmac } from 'node:crypto';
import type { Db, DbPool } from './client.js';

/**
 * 25 distinct sessions. Also a CHECK on `training_signal.k_sessions` and on
 * `signal_counter.shape_only_above_floor` — the constant is here so a caller
 * can reason about it, and enforced there so a caller cannot get around it.
 */
export const K_FLOOR = 25;

/**
 * `HMAC(shape, key)`, domain-tagged.
 *
 * Keyed, not a bare digest. A SHA of a shape is reversible from a wordlist —
 * the shapes are drawn from a ~2,000-word closed vocabulary, which is close to
 * the friendliest possible search space for an attacker — so an unkeyed hash
 * would make `shape_hash` a plaintext shape in all but name.
 */
export function shapeHash(shape: string, indexKey: Buffer): Buffer {
  return createHmac('sha256', indexKey)
    .update('chittu:signal:shape:v1|', 'utf8')
    .update(shape, 'utf8')
    .digest();
}

/**
 * The token that makes "25 DISTINCT sessions" countable without storing which.
 *
 * SCOPED TO THE SHAPE, and that is the design rather than a detail. The same
 * session contributing to two shapes produces two unrelated values, so these
 * rows cannot be joined into "the list of shapes this child produced" — which
 * is precisely the profile the k-floor exists to prevent building.
 *
 * The session id is used to compute this and is never stored. Same arrangement
 * as `sessionPseudonym` in metering-repo, and the same threat model: an
 * attacker who holds the index key AND already knows both the session id and
 * the exact shape can confirm a pairing they had already guessed.
 */
export function contributorToken(
  shapeHashBytes: Buffer, sessionId: string, indexKey: Buffer,
): Buffer {
  return createHmac('sha256', indexKey)
    .update('chittu:signal:contributor:v1|', 'utf8')
    .update(shapeHashBytes)
    .update(sessionId, 'utf8')
    .digest();
}

export interface Observation {
  /** The abstractor's output. Never a child's sentence. */
  readonly shape: string;
  readonly layer: string;
  readonly observedToken: string;
  readonly failureClass: string | null;
  readonly band: string | null;
  readonly country: string | null;
}

export interface ObserveResult {
  readonly kSessions: number;
  /** True on the single turn that took this shape over the floor. */
  readonly reachedFloor: boolean;
}

/**
 * Keep a facet only while every sighting agrees, then drop it for good.
 *
 * `IS DISTINCT FROM` rather than `<>` so NULL compares properly: once a facet
 * has gone NULL it stays NULL, because NULL is distinct from every incoming
 * value including another NULL... which is exactly the sticky behaviour wanted.
 */
const agreeing = (col: string): string =>
  `${col} = CASE WHEN signal_counter.${col} IS DISTINCT FROM EXCLUDED.${col}`
  + ` THEN NULL ELSE signal_counter.${col} END`;

export const signalRepo = {
  /**
   * Count one sighting of a shape. Returns the count; writes the text only at
   * the floor.
   *
   * Opens its OWN transaction, so it must be called on the pool and OUTSIDE any
   * `withChild` scope — PGlite has a single connection and a nested transaction
   * there hangs rather than fails (CLAUDE.md).
   */
  async observe(
    pool: DbPool, o: Observation, sessionId: string, indexKey: Buffer,
  ): Promise<ObserveResult> {
    const h = shapeHash(o.shape, indexKey);
    return pool.transaction(async (tx) => {
      const c = await tx.query<{ k_sessions: number; shape: string | null }>(
        `INSERT INTO signal_counter
           (shape_hash, observed_layer, observed_token, failure_class, band, country,
            sightings, k_sessions)
         VALUES ($1,$2,$3,$4,$5,$6,1,0)
         ON CONFLICT (shape_hash) DO UPDATE SET
           sightings = signal_counter.sightings + 1,
           last_seen_at = now(),
           ${agreeing('observed_layer')},
           ${agreeing('observed_token')},
           ${agreeing('failure_class')},
           ${agreeing('band')},
           ${agreeing('country')}
         RETURNING k_sessions, shape`,
        [h, o.layer, o.observedToken, o.failureClass, o.band, o.country]);
      const row = c.rows[0]!;

      // Past the floor the shape is stored and the contributors are gone, so
      // there is nothing left to de-duplicate against. `sightings` above keeps
      // rising; `k_sessions` is finished.
      if (row.shape !== null) return { kSessions: row.k_sessions, reachedFloor: false };

      const fresh = await tx.query(
        `INSERT INTO signal_contributor (shape_hash, contributor) VALUES ($1,$2)
         ON CONFLICT DO NOTHING RETURNING 1 AS counted`,
        [h, contributorToken(h, sessionId, indexKey)]);
      // This session has produced this shape before. It is one session, so it
      // is one contribution, however many times the child says it.
      if (fresh.rows.length === 0) return { kSessions: row.k_sessions, reachedFloor: false };

      const u = await tx.query<{ k_sessions: number }>(
        `UPDATE signal_counter SET k_sessions = k_sessions + 1
         WHERE shape_hash = $1 RETURNING k_sessions`, [h]);
      const k = u.rows[0]!.k_sessions;
      if (k < K_FLOOR) return { kSessions: k, reachedFloor: false };

      // THE FLOOR. The only write of a shape's text anywhere in this system.
      // `shape IS NULL` makes it idempotent under a concurrent second crosser.
      await tx.query(
        `UPDATE signal_counter SET shape = $2 WHERE shape_hash = $1 AND shape IS NULL`,
        [h, o.shape]);
      // The contributors have done their job. Keeping them would mean holding
      // per-session rows about a shape that is now permanently readable, which
      // is the combination this table was designed to avoid.
      await tx.query(`DELETE FROM signal_contributor WHERE shape_hash = $1`, [h]);
      return { kSessions: k, reachedFloor: true };
    });
  },

  /**
   * A human's judgement about a shape that reached the floor.
   *
   * Not called by the runtime, and the runtime could not call it: chittu_app is
   * granted nothing on `training_signal`. The surface that calls this is
   * `/ops/signals`, which is phase 4 of docs/chittu-model-plan.md.
   *
   * THROWS rather than returning null when the row is not ready. Promotion is a
   * deliberate act by a named person; a silent no-op would leave them believing
   * they had triaged something.
   */
  async promote(
    db: Db,
    shapeHashBytes: Buffer,
    decision: {
      readonly failureClass: string;
      readonly observedLayer: string;
      readonly expectedToken: string | null;
      readonly reviewedBy?: string;
    },
  ): Promise<string> {
    const c = await db.query<{
      shape: string | null; k_sessions: number; promoted_to: string | null;
      observed_token: string | null; band: string | null; country: string | null;
    }>(
      `SELECT shape, k_sessions, promoted_to, observed_token, band, country
         FROM signal_counter WHERE shape_hash = $1`, [shapeHashBytes]);
    const row = c.rows[0];
    if (!row) throw new Error('no such shape');
    if (row.promoted_to !== null) throw new Error('already promoted');
    // Belt to the constraint's braces: `shape` cannot be non-null below the
    // floor, so this can only fire on a row that has not got there yet — and
    // says so in words, rather than as a NOT NULL violation two lines later.
    if (row.shape === null) {
      throw new Error(
        `below the k-anonymity floor: ${row.k_sessions} of ${K_FLOOR} sessions`);
    }

    const s = await db.query<{ id: string }>(
      `INSERT INTO training_signal
         (shape, shape_hash, band, country, observed_layer, observed_token,
          expected_token, failure_class, k_sessions, state, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_HUMAN_REVIEW',$10,
               CASE WHEN $10::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [row.shape, shapeHashBytes, row.band, row.country, decision.observedLayer,
        row.observed_token, decision.expectedToken, decision.failureClass,
        row.k_sessions, decision.reviewedBy ?? null]);
    const id = s.rows[0]!.id;
    await db.query(
      `UPDATE signal_counter SET promoted_to = $2 WHERE shape_hash = $1`,
      [shapeHashBytes, id]);
    return id;
  },
};
