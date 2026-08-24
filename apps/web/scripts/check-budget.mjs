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

/** §2.1: <= 100 KB gzipped for the chat shell. */
const LIMITS = { js: 100 * 1024, css: 25 * 1024 };

let files;
try {
  files = await readdir(DIST);
} catch {
  console.error(`No build found at ${DIST} — run \`pnpm --filter @chittu/web build\` first.`);
  process.exit(1);
}

const totals = { js: 0, css: 0 };
const rows = [];

for (const f of files) {
  const ext = f.endsWith('.js') ? 'js' : f.endsWith('.css') ? 'css' : null;
  if (!ext) continue;
  const raw = await readFile(join(DIST, f));
  const gz = gzipSync(raw, { level: 9 }).length;
  totals[ext] += gz;
  rows.push({ file: f, raw: raw.length, gz });
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const r of rows.sort((a, b) => b.gz - a.gz)) {
  console.log(`  ${r.file.padEnd(34)} ${kb(r.raw).padStart(10)} raw  ${kb(r.gz).padStart(10)} gzipped`);
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
