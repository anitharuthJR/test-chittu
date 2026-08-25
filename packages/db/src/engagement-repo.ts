/**
 * Session metadata for the disengagement signal, and nothing else.
 *
 * Seat 38's standing condition (council-session-001, the one abstention on the
 * Ten Laws): "treat 'the kids stopped talking to it' as a safety incident too.
 * The most dangerous thing we could build is something we're proud of and
 * children ignore." @chittu/disengagement does the classifying; this is the
 * only thing that can hand it real sessions.
 *
 * WHY THE RESULT HAS NO CHILD IDENTIFIER IN IT.
 *
 * A disengagement number is one product decision away from being a retention
 * lever, and Law 04 forbids engagement mechanics outright — no streaks, no
 * guilt, no "don't go". The cheapest way to make that decision unavailable is
 * to make it unbuildable: the query returns a cohort of session lists with no
 * child id, no session id, and no parent id, so there is nothing to address a
 * nudge to. `engagement-repo.test.ts` asserts the exact key set and greps the
 * serialised result for a uuid.
 *
 * It is also why this module does NOT import @chittu/disengagement at runtime.
 * Data access returns data; the classifier lives a layer up and the API
 * composes them. Inverting that would put analysis inside the data layer and
 * make "just add the child id, it's right there" a one-line change.
 */

import type { DbPool } from './client.js';

/**
 * One session, metadata only.
 *
 * Structurally identical to @chittu/disengagement's `SessionSummary` — and
 * declared here rather than imported so the layering above holds. The test
 * passes the result straight into `cohortSignal`, so a drift between the two
 * fails there rather than in production.
 */
export interface SessionMetadata {
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly msgCount: number;
  readonly spineCount: number;
  readonly endedReason: 'child_left' | 'timeout' | 'revoked';
}

/**
 * Columns are NAMED, never `SELECT *`.
 *
 * `session` also holds the classifier's rolling window — which for a `thinker`
 * is the one place a teen's words are written down — plus topic labels and
 * assist notes. A `SELECT *` would satisfy `SessionMetadata` by structural
 * typing and pull all of it into memory anyway. A test asserts this string
 * contains no `*` and none of those column names.
 *
 * `erased`/`deleted_at` is not a soft filter here: a crypto-shredded child is
 * gone, and "gone" has to include gone from a metric. Otherwise the cohort
 * count quietly disagrees with the number of children who exist.
 */
const COHORT_SQL = `
  SELECT s.child_id,
         s.started_at,
         s.ended_at,
         s.ended_reason,
         s.msg_count,
         s.spine_count
    FROM session s
    JOIN child c ON c.id = s.child_id
   WHERE c.deleted_at IS NULL
     AND s.started_at >= now() - ($1::int * INTERVAL '1 day')
   ORDER BY s.child_id, s.started_at ASC`;

interface Row {
  child_id: string;
  started_at: Date;
  ended_at: Date | null;
  ended_reason: string | null;
  msg_count: number;
  spine_count: number;
}

export const engagementRepo = {
  /** Exposed so a test can assert on the query text itself. */
  COHORT_SQL,

  /**
   * Every child's sessions, grouped, newest last.
   *
   * The ordering is load-bearing: `classifyChild` reads cadence from the gaps
   * between consecutive sessions, so an unordered result would produce
   * negative intervals and a nonsense verdict rather than an error.
   *
   * @param windowDays how far back to look. The default is generous because
   *   ABANDONED needs at least a 14-day silence to be claimed at all, and a
   *   window shorter than the thing it measures reports abandonment that is
   *   really just the edge of the window.
   */
  async cohort(pool: DbPool, windowDays = 180): Promise<SessionMetadata[][]> {
    const { rows } = await pool.query<Row>(COHORT_SQL, [windowDays]);

    const byChild = new Map<string, SessionMetadata[]>();
    for (const r of rows) {
      let list = byChild.get(r.child_id);
      if (!list) { list = []; byChild.set(r.child_id, list); }
      list.push({
        startedAt: r.started_at.getTime(),
        endedAt: r.ended_at === null ? null : r.ended_at.getTime(),
        msgCount: Number(r.msg_count),
        spineCount: Number(r.spine_count),
        // Anything unrecognised is treated as the child leaving rather than
        // dropped: a session that ended in a way we have not enumerated still
        // happened, and discarding it would understate engagement.
        endedReason:
          r.ended_reason === 'timeout' || r.ended_reason === 'revoked'
            ? r.ended_reason
            : 'child_left',
      });
    }

    // Values only. The keys are child ids and they stop here — see the header.
    return [...byChild.values()];
  },
};
