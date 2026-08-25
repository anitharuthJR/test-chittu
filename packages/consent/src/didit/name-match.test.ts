/**
 * The name matcher, against names rather than against itself.
 *
 * The corpus is a TSV so the rows read as data and nobody is tempted to derive
 * one from the implementation. Every row is a plausible way a parent types
 * their name against a plausible way a document prints it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchesIdName, normaliseName } from './name-match.js';

interface Row { expect: 'MATCH' | 'NOMATCH'; typed: string; doc: string; note: string }

const rows: Row[] = readFileSync(
  fileURLToPath(new URL('./name-corpus.tsv', import.meta.url)), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [e, typed, doc, note] = l.split('\t');
    return { expect: e as Row['expect'], typed: typed ?? '', doc: doc ?? '', note: note ?? '' };
  });

describe('name corpus', () => {
  // A corpus that silently shrank to nothing would pass every assertion below.
  it('is loaded', () => {
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.expect === 'MATCH').length).toBeGreaterThan(8);
    expect(rows.filter((r) => r.expect === 'NOMATCH').length).toBeGreaterThan(5);
  });

  for (const r of rows) {
    it(`${r.expect}: "${r.typed}" vs "${r.doc}" — ${r.note}`, () => {
      expect(matchesIdName(r.typed, r.doc).matched).toBe(r.expect === 'MATCH');
    });
  }
});

describe('normaliseName', () => {
  it('folds diacritics rather than dropping the letters', () => {
    expect(normaliseName('José Álvarez')).toEqual(['jose', 'alvarez']);
  });

  it('keeps "md", which is a name in South Asia and not a title', () => {
    expect(normaliseName('Md Rafiq')).toEqual(['md', 'rafiq']);
  });

  it('drops honorifics in both scripts of romanisation', () => {
    expect(normaliseName('Thiru Karthik')).toEqual(['karthik']);
    expect(normaliseName('Dr. Priya')).toEqual(['priya']);
  });
});

describe('the anti-wildcard rule', () => {
  it('refuses a match carried entirely by initials', () => {
    expect(matchesIdName('K R', 'KARTHIK RAJENDRAN')).toEqual({
      matched: false, reason: 'no-shared-word',
    });
  });

  it('still accepts one initial beside one real word', () => {
    expect(matchesIdName('R. Karthik', 'KARTHIK RAJENDRAN').matched).toBe(true);
  });

  it('will not let one document token satisfy two typed tokens', () => {
    expect(matchesIdName('Rajendran Rajendran', 'KARTHIK RAJENDRAN').matched).toBe(false);
  });

  it('reports empty input as empty rather than as a mismatch', () => {
    expect(matchesIdName('', 'PRIYA KRISHNAN').reason).toBe('empty');
    expect(matchesIdName('Dr', 'PRIYA KRISHNAN').reason).toBe('empty');
  });
});

describe('the reason never leaks a name', () => {
  it('carries no fragment of either input', () => {
    const r = matchesIdName('Priya Sharma', 'PRIYA KRISHNAN');
    expect(r.matched).toBe(false);
    expect(JSON.stringify(r).toLowerCase()).not.toContain('priya');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('krishnan');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('sharma');
  });
});
