/**
 * The two spellings, and the boundary between them.
 *
 * `Country` is ISO-3166 — where the family is. `Jurisdiction` is the legal
 * regime the `jurisdiction` enum encodes — which law applies. They are NOT the
 * same vocabulary and collapsing them would lose information: `EU` is a
 * jurisdiction with no ISO country code, and `GB` is a country whose regime the
 * schema calls `UK`.
 *
 * That difference is legitimate. What was not legitimate was a mapping that
 * existed, was applied in exactly one file, and failed silently everywhere
 * else — `'GB'::jurisdiction` raises, `setErrorHandler` turns it into a 500,
 * and a British family could not sign up at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from '@chittu/contracts';
import { JURISDICTIONS, toJurisdiction, fromJurisdiction } from './jurisdiction.js';

describe('the jurisdiction enum, as the database actually declares it', () => {
  /**
   * Read from the migration, not retyped. A list retyped beside the schema is
   * a list that drifts from it, and the drift is invisible until an INSERT
   * raises in production.
   */
  it('matches CREATE TYPE jurisdiction in the migration, value for value', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../../db/migrations/0001_init.sql', import.meta.url)), 'utf8');
    const m = sql.match(/CREATE TYPE jurisdiction AS ENUM \(([^)]*)\)/);
    expect(m, 'CREATE TYPE jurisdiction not found').not.toBeNull();
    const declared = m![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect([...JURISDICTIONS]).toEqual(declared);
  });
});

describe('toJurisdiction', () => {
  it('is total over COUNTRIES and never produces a value the enum rejects', () => {
    for (const c of COUNTRIES) {
      expect((JURISDICTIONS as readonly string[]), c).toContain(toJurisdiction(c));
    }
  });

  it('renames only GB — every other market is spelled the same in both', () => {
    expect(toJurisdiction('GB')).toBe('UK');
    for (const c of COUNTRIES.filter((x) => x !== 'GB')) {
      expect(toJurisdiction(c), c).toBe(c);
    }
  });
});

describe('fromJurisdiction', () => {
  it('round-trips every country back to the spelling it went in as', () => {
    for (const c of COUNTRIES) {
      expect(fromJurisdiction(toJurisdiction(c)), c).toBe(c);
    }
  });

  /**
   * `EU` is a regime, not a country, and there is no ISO code to return. The
   * house rule applies — `parseClassifier`, the key-provider allowlist — never
   * invent an answer for input you do not fully recognise. A guessed `'GB'`
   * here would put a British helpline in front of a child in Dublin.
   */
  it('refuses EU rather than guessing a country for it', () => {
    expect(() => fromJurisdiction('EU')).toThrow(/EU/);
  });

  it('refuses a value that is not a jurisdiction at all', () => {
    expect(() => fromJurisdiction('ZZ' as never)).toThrow();
  });
});
