/**
 * The §2.1 performance budget, as a build failure rather than a paragraph.
 *
 * The device floor is a ₹8,000 Android on 3G. A budget that lives only in a
 * document gets exceeded by 20 KB at a time and nobody notices until the phone
 * is in a child's hand.
 *
 * **This measures transfer size only.** It says nothing about LCP on the actual
 * target hardware, which GAP-08 records as never having been measured. Passing
 * here is necessary and nowhere near sufficient — buy the phone.
 */

import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = new URL('../dist/assets/', import.meta.url).pathname;

/**
 * §2.1 sets <= 100 KB gzipped for the chat shell. CSS and fonts get their own
 * ceilings so that one growing cannot quietly eat another's headroom.
 *
 * Fonts are measured RAW, not gzipped: WOFF2 is already Brotli-compressed
 * internally, so gzipping it again saves nothing and reporting the gzipped
 * number would understate what actually crosses a 3G link by a few percent.
 * 90 KB is the four brand faces (~72 KB) plus room for one more weight before
 * someone has to justify it.
 */
const LIMITS = { js: 100 * 1024, css: 25 * 1024, font: 90 * 1024 };

let files;
try {
  files = await readdir(DIST);
} catch {
  console.error(`No build found at ${DIST} — run \`pnpm --filter @chittu/web build\` first.`);
  process.exit(1);
}

const totals = { js: 0, css: 0, font: 0 };
const rows = [];

for (const f of files) {
  const ext = f.endsWith('.js') ? 'js'
    : f.endsWith('.css') ? 'css'
    : f.endsWith('.woff2') ? 'font'
    : null;
  if (!ext) continue;
  const raw = await readFile(join(DIST, f));
  // WOFF2 is Brotli inside; gzipping it again is theatre, so fonts count raw.
  const counted = ext === 'font' ? raw.length : gzipSync(raw, { level: 9 }).length;
  totals[ext] += counted;
  rows.push({ file: f, raw: raw.length, counted, ext });
}

/**
 * Vite inlines assets under 4 KB as data URIs, which is why the Tamil brand-mark
 * face does not appear in `assets/` — it lives inside the stylesheet. That is
 * the right call for a 1.5 KB face the brand shows on every screen (one fewer
 * round trip on 3G beats 500 bytes of base64), but it would otherwise let font
 * bytes hide inside the CSS total. Count them where they belong.
 */
for (const f of files.filter((x) => x.endsWith('.css'))) {
  const css = await readFile(join(DIST, f), 'utf8');
  for (const [, b64] of css.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)) {
    const bytes = Math.floor((b64.length * 3) / 4);
    totals.font += bytes;
    rows.push({ file: `${f} (inlined font)`, raw: bytes, counted: bytes, ext: 'font' });
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const r of rows.sort((a, b) => b.counted - a.counted)) {
  const how = r.ext === 'font' ? 'wire (woff2)' : 'gzipped';
  console.log(`  ${r.file.padEnd(38)} ${kb(r.raw).padStart(10)} raw  ${kb(r.counted).padStart(10)} ${how}`);
}

let failed = false;
for (const [ext, limit] of Object.entries(LIMITS)) {
  const used = totals[ext];
  const pct = ((used / limit) * 100).toFixed(0);
  const verdict = used <= limit ? 'OK' : 'OVER BUDGET';
  if (used > limit) failed = true;
  console.log(`\n${ext.toUpperCase()}: ${kb(used)} of ${kb(limit)} (${pct}%) — ${verdict}`);
}

if (failed) {
  console.error('\nBudget exceeded. The floor is a low-end Android on 3G; this is not advisory.');
  process.exit(1);
}
console.log('\nWithin budget. (Transfer size only — LCP on target hardware is still unmeasured: GAP-08.)');
