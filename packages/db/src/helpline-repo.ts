/**
 * The helpline registry, as data that can go stale.
 *
 * These numbers are read to a child in distress. That makes this the one table
 * where being *out of date* is itself a safety failure: a number that quietly
 * stopped working is worse than a number that was never offered, because the
 * child dials it and nobody answers.
 *
 * Hence the three states. `verified` means a named human checked it and said
 * when to check again. `stale` means that date has passed — probably still
 * correct, but nobody can say so. `P0_WRONG_NUMBER` means we know it is wrong.
 *
 * **Nothing here is on the crisis path's critical path.** The compiled-in
 * `REGISTRY` in `@chittu/safety-kernel` is the floor: reviewed, shipped, and
 * available even if this table, this query or this whole database is
 * unavailable. What the table buys is the ability to CORRECT a number in
 * minutes instead of a release cycle. See `resolveHelplines`.
 */

import type { Db, DbPool } from './client.js';

export type HelplineStatus = 'verified' | 'stale' | 'P0_WRONG_NUMBER';

/**
 * `Country` in contracts uses GB — the ISO code. The `jurisdiction` enum uses
 * UK — what the legislation is called. Same market, two spellings.
 *
 * Every query against a `jurisdiction` column goes through this. It is not a
 * nicety: `'GB'::jurisdiction` raises `invalid input value for enum`, and
 * `resolveHelplines` catches errors and falls back — so without this mapping a
 * British child would silently run on the compiled-in numbers forever, and the
 * only symptom would be a log line nobody reads. It broke the import the first
 * time it was exercised.
 */
export function toJurisdiction(country: string): string {
  return country === 'GB' ? 'UK' : country;
}

export interface HelplineLine {
  readonly name: string;
  readonly number: string;
  readonly hours?: string;
  readonly languages?: readonly string[];
  readonly url?: string;
}

export interface HelplineRow {
  readonly country: string;
  readonly lines: readonly HelplineLine[];
  readonly status: HelplineStatus;
  readonly lastVerified: string;
  readonly verifiedBy: string;
  readonly nextSweep: string;
}

interface RawRow {
  country: string; lines: unknown; status: HelplineStatus;
  last_verified: string; verified_by: string; next_sweep: string;
}

function toRow(r: RawRow): HelplineRow {
  return {
    country: r.country,
    // jsonb comes back parsed on node-postgres and on PGlite, but a string has
    // been seen from other drivers; parse defensively rather than crash on the
    // one table the crisis path reads.
    lines: (typeof r.lines === 'string' ? JSON.parse(r.lines) : r.lines) as HelplineLine[],
    status: r.status,
    lastVerified: new Date(r.last_verified).toISOString(),
    verifiedBy: r.verified_by,
    nextSweep: new Date(r.next_sweep).toISOString(),
  };
}

const COLS = 'country, lines, status, last_verified, verified_by, next_sweep';

export function helplineRepo(pool: DbPool) {
  return {
    async get(db: Db, country: string): Promise<HelplineRow | null> {
      const r = await db.query<RawRow>(
        `SELECT ${COLS} FROM helpline_registry WHERE country = $1::jurisdiction`,
        [toJurisdiction(country)]);
      return r.rows[0] ? toRow(r.rows[0]) : null;
    },

    async listAll(db: Db = pool): Promise<HelplineRow[]> {
      const r = await db.query<RawRow>(
        `SELECT ${COLS} FROM helpline_registry ORDER BY country`);
      return r.rows.map(toRow);
    },

    /**
     * Rows whose re-check date has passed and that nobody has re-checked.
     * `P0_WRONG_NUMBER` rows are excluded: they are already escalated, and
     * sweeping them again would re-raise an alert somebody is already holding.
     */
    async dueForSweep(db: Db = pool, now: Date = new Date()): Promise<HelplineRow[]> {
      const r = await db.query<RawRow>(
        `SELECT ${COLS} FROM helpline_registry
          WHERE next_sweep <= $1 AND status = 'verified'
          ORDER BY next_sweep ASC`, [now.toISOString()]);
      return r.rows.map(toRow);
    },

    async markStale(db: Db, countries: readonly string[]): Promise<number> {
      if (countries.length === 0) return 0;
      const holes = countries.map((_, i) => `$${i + 1}::jurisdiction`).join(', ');
      const r = await db.query(
        `UPDATE helpline_registry SET status = 'stale'
          WHERE country IN (${holes}) AND status = 'verified' RETURNING country`,
        [...countries.map(toJurisdiction)]);
      return r.rows.length;
    },

    /**
     * A named human says these numbers are good, and when to ask again.
     * `verifiedBy` is required by the schema for exactly this reason: an
     * unattributed verification is not a verification.
     */
    async markVerified(
      db: Db, country: string, verifiedBy: string, nextSweep: Date,
      lines?: readonly HelplineLine[],
    ): Promise<void> {
      await db.query(
        `UPDATE helpline_registry
            SET status = 'verified', last_verified = now(),
                verified_by = $2, next_sweep = $3,
                lines = COALESCE($4::jsonb, lines)
          WHERE country = $1::jurisdiction`,
        [toJurisdiction(country), verifiedBy, nextSweep.toISOString(),
         lines ? JSON.stringify(lines) : null]);
    },

    /** We know a number is wrong. This is the state that changes what a child sees. */
    async flagP0(db: Db, country: string, by: string): Promise<void> {
      await db.query(
        `UPDATE helpline_registry
            SET status = 'P0_WRONG_NUMBER', verified_by = $2
          WHERE country = $1::jurisdiction`, [toJurisdiction(country), by]);
    },

    async upsert(
      db: Db, country: string, lines: readonly HelplineLine[],
      verifiedBy: string, nextSweep: Date,
    ): Promise<void> {
      await db.query(
        `INSERT INTO helpline_registry
           (country, lines, status, last_verified, verified_by, next_sweep)
         VALUES ($1::jurisdiction, $2::jsonb, 'verified', now(), $3, $4)
         ON CONFLICT (country) DO UPDATE
           SET lines = EXCLUDED.lines, status = 'verified',
               last_verified = now(), verified_by = EXCLUDED.verified_by,
               next_sweep = EXCLUDED.next_sweep`,
        [toJurisdiction(country), JSON.stringify(lines), verifiedBy, nextSweep.toISOString()]);
    },
  };
}

export type HelplineRepo = ReturnType<typeof helplineRepo>;
