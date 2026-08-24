/**
 * Which providers may be called, read from `provider_clearance`.
 *
 * Requirements §3 leaves minors-use terms open (Seat 10), so a vendor can turn
 * out to be unusable for a market after review. This table is the switch that
 * turns it off **without a code change or a deploy** — which is the whole
 * reason `route()` exists as a single choke point (§12.3).
 *
 * The rule applied here is the conservative one: a provider is usable only if
 * it is cleared for **every enabled market**. It is not per-child today, and
 * that is a real limitation rather than an oversight — `classify()` receives no
 * country, so finer-grained routing needs the jurisdiction threaded through the
 * port. Recorded in PORT-REVIEW. The intersection errs toward calling fewer
 * vendors, which is the safe direction to err in.
 */

import { toJurisdiction, type DbPool } from '@chittu/db';

/** One definition, in the package that owns the enum. Re-exported for callers. */
export { toJurisdiction } from '@chittu/db';

export interface ClearanceReport {
  readonly cleared: ReadonlySet<string>;
  readonly markets: readonly string[];
  /** Providers with SOME clearance but not for every market, and where they fail. */
  readonly partial: Readonly<Record<string, readonly string[]>>;
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
    return { cleared: new Set(), markets, partial: {} };
  }

  // Explicit placeholders rather than `= ANY($1)`: the PGlite driver does not
  // serialise a JS array into a Postgres array literal, and the failure is a
  // runtime `malformed array literal`, not a type error.
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
  return { cleared, markets, partial };
}

/** Markets we have actually turned on. */
export async function enabledMarkets(pool: DbPool): Promise<string[]> {
  const r = await pool.query<{ country: string }>(
    `SELECT country FROM market WHERE enabled = true ORDER BY country`);
  return r.rows.map((x) => x.country);
}
