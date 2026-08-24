/**
 * The fonts, as invariants rather than as good intentions.
 *
 * Self-hosting is a privacy decision, not an aesthetic one: a `<link>` to
 * fonts.googleapis.com sends every child's IP address to a third party on every
 * page load. That is one line to add and nearly invisible in review, which is
 * exactly the kind of change a test should be standing in front of.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const cssRaw = readFileSync(here('./styles.css'), 'utf8');
const html = readFileSync(here('../index.html'), 'utf8');

/**
 * Comments stripped, because the file explains the rule by naming the host it
 * forbids — and a test that cannot tell a prohibition from a violation is worse
 * than no test. What is checked below is the CSS that actually runs.
 */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every .ts/.tsx under src/, so "somewhere in the UI" means all of it. */
function sourceFiles(dir = here('.')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe('no font leaves our origin', () => {
  const HOSTS = [
    'fonts.googleapis.com', 'fonts.gstatic.com', 'use.typekit.net',
    'fast.fonts.net', 'cloud.typography.com', 'cdn.jsdelivr.net', 'unpkg.com',
  ];

  it.each(HOSTS)('the stylesheet never references %s', (host) => {
    expect(css).not.toContain(host);
  });

  it.each(HOSTS)('index.html never references %s', (host) => {
    // The comment in index.html names googleapis to explain the rule, so the
    // check is for a real reference — an href or src — not a mention.
    const refs = [...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(refs.filter((r) => r.includes(host))).toEqual([]);
  });

  it('every @font-face src is a relative path into our own bundle', () => {
    const srcs = [...css.matchAll(/src:\s*url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/['"]/g, ''));
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) {
      expect(s.startsWith('./fonts/'), `${s} is not a local font`).toBe(true);
      expect(s).not.toMatch(/^https?:|^\/\//);
    }
  });

  it('ships a woff2 for every face it declares', () => {
    const srcs = [...css.matchAll(/src:\s*url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/['"]/g, ''));
    for (const s of srcs) {
      expect(existsSync(here(`./${s.replace('./', '')}`)), `${s} is missing`).toBe(true);
    }
  });
});

describe('OFL compliance', () => {
  it('every shipped face has its licence beside it', () => {
    // SIL OFL 1.1 permits redistribution provided the licence travels with the
    // files. Four faces, four licences — a missing one is a licence breach, not
    // an untidiness.
    // Five faces from four families — Nunito ships a second file for ₹.
    const faces = readdirSync(here('./fonts')).filter((f) => f.endsWith('.woff2'));
    const licences = readdirSync(here('./fonts/OFL'));
    expect(faces.length).toBe(5);
    expect(licences.length).toBe(4);
    for (const l of licences) {
      const text = readFileSync(here(`./fonts/OFL/${l}`), 'utf8');
      expect(text, l).toContain('SIL OPEN FONT LICENSE');
    }
  });
});

describe('the Tamil subset covers exactly what the UI renders', () => {
  const TAMIL = /[஀-௿]/gu;

  /**
   * `baloothambi2-tamil-800-brand.woff2` is subset to the characters of the
   * brand mark and nothing else — 1.5 KB instead of 38 KB, which is the only
   * reason a fourth family is affordable at all. That trade is safe *because*
   * the Tamil in this product is one logotype.
   *
   * The moment Tamil appears anywhere else, the subset is wrong and the new text
   * renders as tofu. This is the test that says so, before a child sees it.
   */
  it('the brand mark is the only Tamil in the UI', () => {
    const found = new Map<string, string[]>();
    for (const file of sourceFiles()) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      const text = readFileSync(file, 'utf8');
      const hits = text.match(TAMIL);
      if (hits) found.set(file, [...new Set(hits)]);
    }

    const all = new Set([...found.values()].flat());
    const brand = new Set('சிட்டு');

    expect(
      [...all].filter((c) => !brand.has(c)),
      `Tamil outside the brand mark, in: ${[...found.keys()].join(', ')}. `
      + 'Regenerate the subset with scripts/build-fonts.sh and widen the string.',
    ).toEqual([]);
  });

  it('the subset file is small enough to prove it IS a subset', () => {
    // The full Tamil face is ~38 KB. If this ever approaches that, someone has
    // swapped the subset for the whole font and the budget will follow.
    const size = readFileSync(here('./fonts/baloothambi2-tamil-800-brand.woff2')).length;
    expect(size).toBeLessThan(8 * 1024);
    expect(size).toBeGreaterThan(500);       // ...and is not an empty stub
  });
});

/**
 * Coverage, read from the cmap of the built files rather than inferred.
 *
 * This exists because of a bug that a reasonable-looking check missed. The trace
 * strip joins pipeline layers with `→`, which is NOT in Google's `latin`
 * subset — so it rendered from whatever monospace face the device had, mixed
 * into a line that was otherwise IBM Plex Mono. Measuring the glyph's width did
 * not catch it: the system fallback was also monospace, so the advance matched
 * and the character looked present.
 *
 * The only thing that settles it is what the font table says.
 */
describe('subset coverage', () => {
  const coverage = JSON.parse(
    readFileSync(here('./fonts/coverage.json'), 'utf8'),
  ) as Record<string, number[]>;

  const covers = (file: string, s: string): string[] => {
    const set = new Set(coverage[file]);
    return [...s].filter((c) => !set.has(c.codePointAt(0)!));
  };

  /** Characters the UI is known to put through the latin faces. */
  const REQUIRED =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    + ` !"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`
    + '·—–…’‘“”'          // typographic punctuation used throughout the copy
    + '×÷−';              // maths lessons

  it.each([
    'nunito-latin-var.woff2',
    'baloo2-latin-var.woff2',
    'plexmono-latin-400.woff2',
  ])('%s covers everything the UI renders in it', (file) => {
    expect(covers(file, REQUIRED)).toEqual([]);
  });

  it('Nunito covers ₹ — this is an India-first product', () => {
    // Not in Google's `latin`; pulled from `latin-ext` as its own 1.2 KB face
    // with unicode-range U+20B9. Money appears in maths lessons, and a
    // fallback glyph mid-sentence in body copy is very visible.
    expect(covers('nunito-ext-rupee-var.woff2', '₹')).toEqual([]);
  });

  /**
   * Characters the UI renders that NO face here can provide, because the
   * upstream families do not contain them — checked, not assumed: `→` and `↳`
   * are absent from every subset of Nunito, Baloo 2 and IBM Plex Mono.
   *
   * They therefore come from a system font. That is fine for a 9.5px diagnostic
   * strip and it is what essentially every site does, but it should be a
   * recorded decision rather than something someone rediscovers.
   *
   * If a font update ever adds them this test fails — which is the signal to
   * put them in the subset and delete this block.
   */
  it('records the two characters that knowingly fall back', () => {
    const faces = Object.keys(coverage);
    for (const ch of '→↳') {
      const provided = faces.filter((f) => covers(f, ch).length === 0);
      expect(provided, `${ch} is now available in ${provided.join(', ')} — subset it and drop this test`)
        .toEqual([]);
    }
  });

  it('the Tamil face covers the brand mark exactly, and nothing more', () => {
    const file = 'baloothambi2-tamil-800-brand.woff2';
    expect(covers(file, 'சிட்டு')).toEqual([]);

    // And it really is a subset: the full Tamil face maps hundreds of
    // codepoints. If this grows, someone shipped the whole 38 KB font.
    const tamil = coverage[file]!.filter((c) => c >= 0x0b80 && c <= 0x0bff);
    expect(tamil.length).toBeLessThan(12);
  });

  it('the manifest matches the files actually shipped', () => {
    const shipped = readdirSync(here('./fonts')).filter((f) => f.endsWith('.woff2')).sort();
    expect(Object.keys(coverage).sort()).toEqual(shipped);
  });
});

describe('font-display', () => {
  it('every face swaps rather than blocking first paint', () => {
    // The device floor is a low-end Android on 3G. A blocked first paint is a
    // worse failure than a reflow.
    const faces = css.split('@font-face').slice(1);
    expect(faces.length).toBe(5);
    for (const f of faces) expect(f).toMatch(/font-display:\s*swap/);
  });
});
