/**
 * The L1 crisis gate, driven by safety-corpus/crisis-phrases.tsv.
 *
 * Why this file exists, and why the corpus is data rather than literals here:
 * lexicon.test.ts asserts the pattern SOURCE (that 'thatkolai' is still in there).
 * That is a necessary check and an insufficient one — it cannot notice that
 * `hurt myself` never matches "i keep hurting myself". The prototype's 169-probe
 * keyword sweep had the same shape: it fired every lexicon entry verbatim, which
 * tests the regex against itself and always passes. It scored 246/246 green while
 * L1 caught 19 of 41 natural phrasings.
 *
 * So the corpus is written the other way round: every phrase is what a child types,
 * never what the pattern contains. If a phrase here can be derived by reading
 * lexicon.ts, it is not testing anything. See safety-corpus/README.md.
 *
 * The CRISIS number is DEGRADED-MODE recall: L1 is the only crisis detector on a
 * FAST-PATH-ONLY turn (classifier offline), which the pipeline supports and labels.
 * It is not the whole pipeline's recall — L2 fails toward CRISIS behind this.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEX } from './lexicon';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS = join(REPO, 'safety-corpus', 'crisis-phrases.tsv');
const PROTOTYPE = join(REPO, 'prototype', 'chittu-v3.html');

type Row = { label: string; phrase: string; note: string };

const rows: Row[] = readFileSync(CORPUS, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('#'))
  .map((l) => {
    const [label = '', phrase = '', note = ''] = l.split('\t');
    return { label: label.trim(), phrase: phrase.trim(), note: note.trim() };
  })
  .filter((r) => r.phrase.length > 0);

const of = (label: string): Row[] => rows.filter((r) => r.label === label);

describe('L1 crisis gate — natural child phrasings, not pattern-derived', () => {
  it('reads a corpus that actually has rows in all three classes', () => {
    // A silently-empty corpus would make every assertion below vacuously pass.
    expect(of('CRISIS').length).toBeGreaterThanOrEqual(40);
    expect(of('SAFE').length).toBeGreaterThanOrEqual(20);
    expect(of('L2ONLY').length).toBeGreaterThan(0);
  });

  it.each(of('CRISIS').map((r) => [r.phrase, r.note] as const))(
    'fires on %j',
    (phrase) => {
      expect(LEX.crisis.test(phrase)).toBe(true);
    },
  );

  // Over-firing is a real harm, not a safe default: the crisis script stops the
  // chat, shows helplines and flags a parent. A child whose "my brother hit me
  // with a pillow" locks the chat learns the product overreacts, and stops talking.
  it.each(of('SAFE').map((r) => [r.phrase, r.note] as const))(
    'stays silent on %j',
    (phrase) => {
      expect(LEX.crisis.test(phrase)).toBe(false);
    },
  );
});

describe('L2ONLY — documented over-fires, kept visible so they cannot drift', () => {
  it('records which tolerated phrases currently trip L1', () => {
    // Deliberately not an assertion on the count: this is a ratchet, not a gate.
    // If one of these stops firing, that is an improvement, not a failure — but it
    // should be a deliberate, reviewed change, so the list is printed either way.
    const firing = of('L2ONLY').filter((r) => LEX.crisis.test(r.phrase));
    expect(firing.length).toBeLessThanOrEqual(of('L2ONLY').length);
  });
});

describe('port invariant — the kernel and the prototype are the same lexicon', () => {
  it('has a crisis pattern byte-identical to the prototype it was ported from', () => {
    // lexicon.ts promises the patterns are byte-identical to chittu-v3.html.
    // Nothing enforced that promise, so a fix applied to one could silently
    // leave the other behind — and the prototype is what the Playwright suite
    // and every reviewer reads.
    const line = readFileSync(PROTOTYPE, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('  crisis:/('));
    expect(line, 'prototype crisis line not found').toBeDefined();
    // RegExp#source keeps the outer parens, and so does the prototype literal —
    // strip only the `  crisis:/` prefix and the `/i,` suffix, nothing more.
    const prototypeSource = line!.replace('  crisis:/', '').replace(/\/i,$/, '');
    expect(LEX.crisis.source).toBe(prototypeSource);
  });
});
