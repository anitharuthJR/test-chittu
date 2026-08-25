/**
 * The abstractor, driven by safety-corpus/child-sentences.tsv.
 *
 * `abstractor.test.ts` next door checks the rules one at a time, which is the
 * necessary half. This is the other half: run sentences nobody wrote by reading
 * the implementation, and assert properties that hold for ALL of them.
 *
 * The load-bearing one is the first. Every token of a shape is a vocabulary
 * word or one of six placeholders — no exceptions, no allowance for "close
 * enough". That single assertion is the privacy property, and it does not care
 * what the input was: a name, a phone number, a Tamil sentence, a rare disease,
 * an address. If it survived, it was already in a ~2,000-word list that ships
 * in the repo and describes nobody.
 *
 * The second is the irreversibility one. Rows sharing a `group` must produce
 * the SAME shape. That is the gate the model plan asks for, written down: a
 * reviewer handed `my <PET> died and i feel <EMOTION>` cannot say which of four
 * children typed it, because the corpus proves four different sentences make
 * it. A change that starts telling them apart fails here, which is correct —
 * telling them apart IS the failure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abstractShape, PLACEHOLDERS, SHAPE_RE } from './abstractor.js';
import { COMMON } from './vocabulary.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS = join(REPO, 'safety-corpus', 'child-sentences.tsv');

interface Row { group: string; sentence: string; note: string }

/**
 * The sentence field is NOT trimmed. One row is deliberately whitespace only,
 * and trimming it here would delete the case instead of testing it.
 */
const rows: Row[] = readFileSync(CORPUS, 'utf8')
  .split('\n')
  .filter((l) => l.length > 0 && !l.startsWith('#'))
  .map((l) => {
    const [group = '', sentence = '', note = ''] = l.split('\t');
    return { group: group.trim(), sentence, note: note.trim() };
  })
  .filter((r) => r.group.length > 0);

const placeholderSet = new Set<string>(PLACEHOLDERS);

describe('the corpus itself', () => {
  it('has enough rows, and enough groups, to be worth running', () => {
    expect(rows.length).toBeGreaterThanOrEqual(50);
    const groups = new Set(rows.filter((r) => r.group !== '-').map((r) => r.group));
    expect(groups.size).toBeGreaterThanOrEqual(8);
  });

  it('contains distinctive tokens for the abstractor to destroy', () => {
    // If every sentence were already made of common words this file would prove
    // nothing. Count the tokens that are NOT in the vocabulary — those are the
    // ones the assertions below are actually about.
    const distinctive = rows.flatMap((r) =>
      r.sentence.toLowerCase().split(/\s+/).filter((w) => w.length > 0 && !COMMON.has(w)));
    expect(distinctive.length).toBeGreaterThanOrEqual(40);
  });
});

describe('THE privacy property — nothing distinctive survives', () => {
  for (const r of rows) {
    it(`only vocabulary and placeholders: ${JSON.stringify(r.sentence)}`, () => {
      const shape = abstractShape(r.sentence);
      if (shape === null) return;  // nothing abstractable; covered in abstractor.test.ts
      for (const tok of shape.split(' ')) {
        expect(
          placeholderSet.has(tok) || COMMON.has(tok),
          `"${tok}" survived abstraction and is neither a placeholder nor a `
          + `vocabulary word.\n  in:  ${JSON.stringify(r.sentence)}\n  out: ${shape}`,
        ).toBe(true);
      }
    });
  }

  it('no input word outside the vocabulary appears anywhere in its shape', () => {
    // The same guarantee stated the other way round, so a failure names the
    // leaked word rather than the surviving token. Derived from the CORPUS,
    // never from the implementation.
    const leaks: string[] = [];
    for (const r of rows) {
      const shape = abstractShape(r.sentence);
      if (shape === null) continue;
      for (const w of r.sentence.toLowerCase().split(/[^a-z0-9'-]+/)) {
        if (w.length === 0 || COMMON.has(w)) continue;
        if (shape.split(' ').includes(w)) leaks.push(`${w} <- ${r.sentence}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('never emits a digit, a capital, or punctuation the column would refuse', () => {
    for (const r of rows) {
      const shape = abstractShape(r.sentence);
      if (shape === null) continue;
      // The database CHECK, duplicated in the kernel and pinned to the SQL by
      // abstractor.test.ts. A shape that fails here would be rejected at INSERT
      // — but by then the abstractor has already been trusted by a caller.
      expect(shape, `${JSON.stringify(r.sentence)} -> ${shape}`).toMatch(SHAPE_RE);
    }
  });
});

describe('irreversibility — different children, one shape', () => {
  const groups = [...new Set(rows.filter((r) => r.group !== '-').map((r) => r.group))];

  for (const g of groups) {
    it(`group "${g}" collapses to a single shape`, () => {
      const members = rows.filter((r) => r.group === g);
      expect(members.length).toBeGreaterThanOrEqual(3);
      const shapes = members.map((r) => ({ sentence: r.sentence, shape: abstractShape(r.sentence) }));
      const distinct = new Set(shapes.map((s) => s.shape));
      expect(
        distinct.size,
        `group "${g}" produced ${distinct.size} shapes, not 1:\n`
        + shapes.map((s) => `  ${JSON.stringify(s.sentence)}\n    -> ${s.shape}`).join('\n'),
      ).toBe(1);
    });
  }

  it('the corpus as a whole collapses — fewer shapes than sentences', () => {
    const shapes = rows.map((r) => abstractShape(r.sentence)).filter((s) => s !== null);
    const distinct = new Set(shapes);
    // Not a tuning knob. It is the difference between a store of shapes and a
    // store of sentences with the nouns knocked out.
    expect(distinct.size).toBeLessThan(shapes.length);
  });
});
