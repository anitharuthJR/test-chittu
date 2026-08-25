/**
 * Which providers may be called, read from `provider_clearance`.
 *
 * Requirements §3 leaves minors-use terms open (Seat 10), so a vendor can turn
 * out to be unusable for a market after review. This table is the switch that
 * turns it off **without a code change or a deploy** — which is the whole
 * reason `route()` exists as a single choke point (§12.3).
 *
 * TWO ANSWERS, and which one you get depends on what the caller knows.
 *
 * `byCountry` is what the table actually says: provider -> the jurisdictions it
 * is cleared for. The router uses it whenever the turn's band and country are
 * known, which is every child turn since routing gained a RouteContext.
 *
 * `cleared` is the conservative intersection — usable only if cleared for EVERY
 * enabled market. It remains the answer for a caller with no turn in hand (a
 * health check, an ops command), because a route with no country cannot be
 * checked against one. It used to be the answer for every turn, since
 * `classify()` received no country; that was a real limitation and PORT-REVIEW
 * recorded it. It is no longer the common path, and the intersection still errs
 * toward calling fewer vendors, which is the safe direction to err in.
 */

import { toJurisdiction, type DbPool } from '@chittu/db';

/** One definition, in the package that owns the enum. Re-exported for callers. */
export { toJurisdiction } from '@chittu/db';

export interface ClearanceReport {
  readonly cleared: ReadonlySet<string>;
  readonly markets: readonly string[];
  /** Providers with SOME clearance but not for every market, and where they fail. */
  readonly partial: Readonly<Record<string, readonly string[]>>;
  /**
   * provider -> the jurisdictions it is cleared for.
   *
   * This is what the table actually says, and the router now uses it whenever
   * the turn's country is known. `cleared` above is the intersection across
   * every enabled market — the conservative answer you are forced into when the
   * country is unknown, which used to be every turn.
   */
  readonly byCountry: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * @param markets jurisdictions this deployment serves. Empty means no market is
 *   enabled, and then nothing is cleared — refusing to call a vendor when we do
 *   not know who we are serving is the correct reading, not a bug.
 */
export async function readClearance(
  pool: DbPool, markets: readonly string[],
): Promise<ClearanceReport> {
  if (markets.length === 0) {
    return { cleared: new Set(), markets, partial: {}, byCountry: new Map() };
  }

  // Explicit placeholders rather than `= ANY($1)`. Written for a second driver
  // that could not serialise a JS array into a Postgres array literal — the
  // failure was a runtime `malformed array literal`, not a type error. That
  // driver is gone; this is kept because it also casts each element to
  // `jurisdiction` explicitly, which `= ANY($1)` would not.
  const holes = markets.map((_, i) => `$${i + 1}::jurisdiction`).join(', ');
  const r = await pool.query<{ provider: string; jurisdiction: string }>(
    `SELECT provider, jurisdiction FROM provider_clearance
      WHERE revoked_at IS NULL
        AND expires_at > now()
        AND jurisdiction IN (${holes})`,
    [...markets.map(toJurisdiction)]);

  const byProvider = new Map<string, Set<string>>();
  for (const row of r.rows) {
    const set = byProvider.get(row.provider) ?? new Set<string>();
    set.add(row.jurisdiction);
    byProvider.set(row.provider, set);
  }

  const cleared = new Set<string>();
  const partial: Record<string, string[]> = {};
  for (const [provider, got] of byProvider) {
    const missing = markets.filter((m) => !got.has(m));
    if (missing.length === 0) cleared.add(provider);
    else partial[provider] = missing;
  }
  return { cleared, markets, partial, byCountry: byProvider };
}

/** Markets we have actually turned on. */
export async function enabledMarkets(pool: DbPool): Promise<string[]> {
  const r = await pool.query<{ country: string }>(
    `SELECT country FROM market WHERE enabled = true ORDER BY country`);
  return r.rows.map((x) => x.country);
}
