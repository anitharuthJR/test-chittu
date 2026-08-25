/**
 * The two spellings of a market, and the only place they are allowed to meet.
 *
 * `Country` (contracts) is ISO-3166 — *where the family is*. `Jurisdiction`
 * (the `jurisdiction` enum) is the legal regime — *which law applies*. They are
 * genuinely different vocabularies and collapsing them would lose information:
 * `EU` is a regime with no ISO country code, and `GB` is a country whose regime
 * the schema calls `UK`.
 *
 * WHAT WENT WRONG, and why this file exists rather than a free function in
 * `helpline-repo.ts` where the mapping used to live. `toJurisdiction` was
 * correct and was called from exactly one file. Everywhere else a `Country`
 * went straight into a `jurisdiction` column: `'GB'::jurisdiction` raises
 * `invalid input value for enum`, `setErrorHandler` turns it into a generic
 * 500, and **a British family could not complete consent at all** — one of six
 * markets, unreachable, with no symptom that named the cause. The second write
 * (`signal_counter.country`) was quieter still: it sits inside a try/catch that
 * logs and carries on, so a British child's signal capture failed with no
 * symptom whatsoever. And in `helpline_registry` — the one place the mapping WAS
 * applied — the same omission would have been quieter again: `resolveHelplines`
 * catches and falls back, so an unmapped British child would have run on the
 * compiled-in numbers forever with a log line nobody reads as the only trace.
 * Three columns, three volumes of failure, one missing call.
 *
 * THE ENFORCEMENT IS THE TYPE, not this comment. Every row type that reads a
 * `jurisdiction` column is declared `Jurisdiction`, so a raw column value
 * cannot flow into a `Country` field without going through `fromJurisdiction`.
 * `ConsentRow.jurisdiction` used to be declared `Country`, which is what let
 * the read half compile while being wrong. A mapping nobody can forget beats a
 * mapping everybody is asked to remember.
 *
 * NOTHING CONVERTS ON THE DOMAIN SIDE. `canonicalise` puts
 * `ConsentRecord.jurisdiction` in the seal hash, so the record keeps the ISO
 * spelling it was sealed with; the enum's spelling exists only inside the
 * column. Converting in and not out would round-trip `UK` into a field sealed
 * as `GB` and break every British family's ledger check.
 */

import type { Country } from '@chittu/contracts';

/**
 * `CREATE TYPE jurisdiction AS ENUM (…)` in `db/migrations/0001_init.sql`,
 * in declaration order. `jurisdiction.test.ts` reads the migration and fails if
 * these two ever disagree — a list retyped beside a schema is a list that
 * drifts from it, and the drift is invisible until an INSERT raises.
 */
export const JURISDICTIONS = [
  'IN', 'US', 'UK', 'EU', 'AU', 'SG', 'AE',
] as const;

export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** The one market whose two spellings differ. */
const COUNTRY_TO_JURISDICTION: Partial<Record<Country, Jurisdiction>> = { GB: 'UK' };
const JURISDICTION_TO_COUNTRY: Partial<Record<Jurisdiction, Country>> = { UK: 'GB' };

/**
 * ISO country -> the enum value to store. Total over `Country` by construction:
 * every value not in the rename table is spelled identically in both.
 */
export function toJurisdiction(country: Country | string): Jurisdiction {
  return COUNTRY_TO_JURISDICTION[country as Country] ?? (country as Jurisdiction);
}

/**
 * The enum value -> the ISO country to hand back out.
 *
 * THROWS on `EU`, and on anything that is not a jurisdiction at all. `EU` is a
 * regime covering many countries and there is no ISO code to return; a guessed
 * `'GB'` here would put a British helpline in front of a child in Dublin. Same
 * rule as `parseClassifier` and the key-provider allowlist — never invent an
 * answer for input you do not fully recognise, because the invented one is
 * indistinguishable from a correct one until the moment it matters.
 *
 * No code path can write `EU` into a child's row today (`child.country` and
 * `consent_record.jurisdiction` are both written from a `Country`), so this
 * throwing is a guard against a future the schema already allows, not a case
 * callers must handle.
 */
export function fromJurisdiction(j: Jurisdiction): Country {
  const mapped = JURISDICTION_TO_COUNTRY[j];
  if (mapped !== undefined) return mapped;
  if (j === 'EU') {
    throw new Error(
      'EU is a legal jurisdiction, not a country — there is no ISO code to '
      + 'return. A row storing it needs a country of its own.',
    );
  }
  if (!(JURISDICTIONS as readonly string[]).includes(j)) {
    throw new Error(`not a jurisdiction: ${JSON.stringify(j)}`);
  }
  return j as unknown as Country;
}
