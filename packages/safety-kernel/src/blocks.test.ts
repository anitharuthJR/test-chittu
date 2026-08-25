/**
 * Block-grammar tests.
 *
 * There was no `blocks.test.ts` until now: the coverage was `BlockRenderer.test.tsx`
 * (which starts from an already-parsed `Block[]`) and the prototype's Playwright
 * suite (which drives the prototype's parser, not this one). So the one module that
 * turns model output into UI had no direct test of its own.
 *
 * The unclosed-tag behaviour pinned below is a KNOWN DEFECT that is NOT fixed here.
 * It is byte-for-byte what the prototype does, and CLAUDE.md is explicit that
 * `parseBlocks` preserves prototype quirks deliberately and that widening a ported
 * safety behaviour is a Guardian Council decision. These tests pin the current
 * behaviour so that (a) it cannot change by accident, and (b) whoever implements the
 * signed-off fix has to come here and change an assertion deliberately, with the
 * consequence written next to it. See PORT-REVIEW.md §12.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks, stripBlocks, flatten } from './blocks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROTOTYPE = join(REPO, 'prototype', 'chittu-v3.html');

/** The prose of a parse, or '' when no text block survived. */
function proseOf(text: string): string {
  const b = parseBlocks(text).find((x) => x.kind === 'text');
  return b?.kind === 'text' ? b.text : '';
}

function chipsOf(text: string): string[] | null {
  const b = parseBlocks(text).find((x) => x.kind === 'chips');
  return b?.kind === 'chips' ? [...b.chips] : null;
}

/* ------------------------------------------------------------------ *
 * 1. The defect, pinned.
 * ------------------------------------------------------------------ */

describe('unclosed block tags leak their body as prose — PINNED, not endorsed', () => {
  /**
   * Observed live on 2026-08-25 against the real Anthropic sandbox, band
   * `builder`. `extract()` requires BOTH tags, so an unclosed `[CHIPS]` matches
   * nothing; `ANY_TAG` then strips the bare marker and the chip labels survive as
   * a sentence, pipes and all. The child saw the string asserted below.
   */
  it('renders unterminated CHIPS labels as a sentence, pipes included', () => {
    const reply =
      'Does Mani have a favourite spot? [BIG]X[/BIG] '
      + '[CHIPS]Yes, a cozy spot!|On my bed|I am not sure';

    expect(proseOf(reply)).toBe(
      'Does Mani have a favourite spot? Yes, a cozy spot!|On my bed|I am not sure',
    );
    // and no chips are produced, so the affordance is lost as well as leaked
    expect(chipsOf(reply)).toBeNull();
  });

  it('leaks every tag, not only CHIPS', () => {
    expect(proseOf('Answer here. [FACT]unclosed fact body'))
      .toBe('Answer here. unclosed fact body');
    expect(proseOf('Do it. [STEPS]one|two|three'))
      .toBe('Do it. one|two|three');
    expect(proseOf('Look! [POEM]a line|another'))
      .toBe('Look! a line|another');
  });

  /**
   * The leak is not confined to the screen. `flatten` is what the seal chain
   * hashes and what TTS speaks, so a malformed reply is also read aloud with its
   * separators and sealed in that form.
   */
  it('carries the leak into flatten, so TTS speaks it and the chain seals it', () => {
    const flat = flatten(parseBlocks('Pick one. [CHIPS]red|blue|green'));
    expect(flat).toContain('red|blue|green');
  });

  it('is correct when the tag IS closed — the pair is the only working case', () => {
    expect(proseOf('ok [CHIPS]a|b[/CHIPS] tail')).toBe('ok tail');
    expect(chipsOf('ok [CHIPS]a|b[/CHIPS] tail')).toEqual(['a', 'b']);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The port invariant: this parser and the prototype's agree.
 * ------------------------------------------------------------------ */

describe('port invariant — the kernel and the prototype parse the same', () => {
  /**
   * Same technique as `crisis-corpus.test.ts`, which pins the crisis regex to the
   * prototype's literal. The prototype is the reference implementation; a fix
   * applied to one and not the other is exactly the drift CLAUDE.md warns about,
   * and the prototype's own Playwright suite would keep passing through it.
   */
  const src = readFileSync(PROTOTYPE, 'utf8');
  const start = src.indexOf('function parseBlocks(text){');
  const end = src.indexOf('function stripBlocks(text){');
  const protoSrc = src.slice(start, end);

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const protoParse = new Function(`${protoSrc}; return parseBlocks;`)() as
    (t: string) => { prose: string; chips: string[] | null };

  it('found the prototype function to compare against', () => {
    expect(start, 'prototype parseBlocks not found').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(typeof protoParse).toBe('function');
  });

  const cases = [
    'Does Mani have a favourite spot? [BIG]X[/BIG] [CHIPS]Yes, a cozy spot!|On my bed|I am not sure',
    '[CHIPS]a|b|c',
    'Answer here. [FACT]unclosed fact body',
    'Do it. [STEPS]one|two|three',
    'ok [CHIPS]a|b[/CHIPS] tail',
    'plain prose with no markup at all',
    'two [BIG]A[/BIG] of [BIG]B[/BIG] the same tag',
    'A [FACT]f[/FACT] and [CHIPS]x|y[/CHIPS] together',
  ];

  for (const c of cases) {
    it(`agrees with the prototype on: ${JSON.stringify(c).slice(0, 56)}`, () => {
      expect(proseOf(c)).toBe(protoParse(c).prose);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 3. The quirks CLAUDE.md names, so a fix cannot quietly change them too.
 * ------------------------------------------------------------------ */

describe('deliberate quirks (CLAUDE.md) stay put', () => {
  it('extracts only the FIRST occurrence of a tag and strips the rest', () => {
    expect(parseBlocks('[BIG]A[/BIG] mid [BIG]B[/BIG]'))
      .toContainEqual({ kind: 'big', emoji: 'A' });
    expect(proseOf('[BIG]A[/BIG] mid [BIG]B[/BIG]')).toBe('mid B');
  });

  it('truncates BIG to 8 characters', () => {
    const b = parseBlocks('[BIG]123456789012[/BIG]').find((x) => x.kind === 'big');
    expect(b?.kind === 'big' && b.emoji).toBe('12345678');
  });

  it('DROPS a chip over 30 characters rather than truncating it', () => {
    expect(chipsOf(`[CHIPS]ok|${'x'.repeat(31)}[/CHIPS]`)).toEqual(['ok']);
  });

  it('keeps at most 3 chips', () => {
    expect(chipsOf('[CHIPS]a|b|c|d[/CHIPS]')).toEqual(['a', 'b', 'c']);
  });

  it('keeps at most 8 steps and applies no length rule to them', () => {
    const long = 'y'.repeat(40);
    const s = parseBlocks(`[STEPS]${long}|2|3|4|5|6|7|8|9[/STEPS]`)
      .find((x) => x.kind === 'steps');
    expect(s?.kind === 'steps' && s.items.length).toBe(8);
    expect(s?.kind === 'steps' && s.items[0]).toBe(long);
  });

  it('stripBlocks returns the prose only', () => {
    expect(stripBlocks('hi [FACT]f[/FACT] there')).toBe('hi there');
  });
});
