/**
 * Which helpline numbers a child actually gets.
 *
 * The rule, and the reason for each branch:
 *
 * | registry state | what the child gets | why |
 * |---|---|---|
 * | `verified` | the registry's lines | someone checked them |
 * | `stale` | **the registry's lines** | overdue is not wrong |
 * | `P0_WRONG_NUMBER` | the compiled-in constant | we know these are wrong |
 * | no row | the compiled-in constant | nothing has been loaded yet |
 * | query failed | the compiled-in constant | the crisis path does not wait on a database |
 *
 * **`stale` deliberately changes nothing a child sees.** It is an operational
 * state, not a content state. Withholding a probably-correct helpline from a
 * child in crisis because our own re-check date slipped would be us punishing
 * the child for our process failure — and a missing number is a worse outcome
 * than an unverified one. Staleness pages an adult; it does not edit the script.
 *
 * `P0_WRONG_NUMBER` is the opposite, and the only state that does change the
 * script: a number known to be wrong is worse than no number at all, because a
 * child dials it and nobody answers.
 */

import type { Country } from '@chittu/contracts';
import { REGISTRY, helplineText } from '@chittu/safety-kernel';
import { helplineRepo, type Db, type DbPool, type HelplineStatus } from '@chittu/db';

export interface ResolvedHelplines {
  readonly country: Country;
  readonly name: string;
  readonly lines: readonly { readonly name: string; readonly contact: string }[];
  /** One line, formatted for the scripted crisis reply. */
  readonly text: string;
  readonly status: HelplineStatus;
  /** `builtin` means the registry was unusable and the shipped copy was used. */
  readonly source: 'registry' | 'builtin';
  readonly lastVerified: string | null;
}

function builtin(country: Country, status: HelplineStatus): ResolvedHelplines {
  const r = REGISTRY[country];
  return {
    country, name: r.name, lines: r.lines, text: helplineText(country),
    status, source: 'builtin', lastVerified: null,
  };
}

/**
 * @param db the caller's handle — a pool OUTSIDE a transaction, or the `tx`
 *   INSIDE one. Passing the pool while the caller holds a transaction takes a
 *   second connection, which deadlocks on PGlite and reads a different snapshot
 *   on a real server. This repo learned that once already (PORT-REVIEW), and
 *   this signature is why it cannot be fudged again.
 */
export async function resolveHelplines(
  db: Db | DbPool, country: Country,
): Promise<ResolvedHelplines> {
  let row;
  try {
    row = await helplineRepo(db as DbPool).get(db, country);
  } catch {
    // The database is the OVERLAY, never the dependency. If it is unreachable
    // the child still gets the numbers we shipped.
    return builtin(country, 'stale');
  }

  if (row === null) return builtin(country, 'stale');
  if (row.status === 'P0_WRONG_NUMBER') return builtin(country, row.status);
  if (row.lines.length === 0) return builtin(country, row.status);

  const lines = row.lines.map((l) => ({
    name: l.name,
    contact: [l.number, l.hours].filter(Boolean).join(' · '),
  }));

  return {
    country,
    name: REGISTRY[country].name,
    lines,
    text: lines.map((l) => `${l.name} ${l.contact}`).join(' · '),
    status: row.status,
    source: 'registry',
    lastVerified: row.lastVerified,
  };
}
