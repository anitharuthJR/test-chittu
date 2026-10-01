/**
 * Sweep a JSONL story corpus through Chittu's L1 + L6 guards — the real kernel.
 *
 *   pnpm story:sweep -- <in.jsonl> <out.jsonl> <report.json> [--fields story,summary] [--verdicts <verdicts.jsonl>]
 *
 * Writes <report.json> and, beside it, <report>.md with a blank human-read section. With
 * --verdicts, also one verdict line per record (kept or dropped), so a card can label each one.
 * All logic is in src/story-corpus/ (typechecked, unit-tested); this file owns argv and
 * file handles only — apps/api/scripts is outside tsconfig's `include`.
 */
import { createReadStream, createWriteStream, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sweepStream } from '../src/story-corpus/stream.js';
import { renderReport } from '../src/story-corpus/sweep.js';

interface Args {
  inPath: string;
  outPath: string;
  reportPath: string;
  fields: string[];
  verdictsPath: string | null;
}

function usage(): never {
  console.error('usage: pnpm story:sweep -- <in.jsonl> <out.jsonl> <report.json> [--fields story,summary] [--verdicts <verdicts.jsonl>]');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let fields = ['story', 'summary'];
  let verdictsPath: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') continue;
    if (a === '--fields') fields = (argv[++i] ?? '').split(',');
    else if (a.startsWith('--fields=')) fields = a.slice('--fields='.length).split(',');
    else if (a === '--verdicts') verdictsPath = argv[++i] ?? '';
    else if (a.startsWith('--verdicts=')) verdictsPath = a.slice('--verdicts='.length);
    else positional.push(a);
  }
  fields = fields.map((f) => f.trim()).filter((f) => f !== '');
  const [inPath, outPath, reportPath] = positional;
  if (positional.length !== 3 || inPath === undefined || outPath === undefined || reportPath === undefined || fields.length === 0 || verdictsPath === '') usage();
  return { inPath, outPath, reportPath, fields, verdictsPath };
}

async function main(): Promise<void> {
  const { inPath, outPath, reportPath, fields, verdictsPath } = parseArgs(process.argv.slice(2));
  const tmpPath = outPath + '.tmp';
  const out = createWriteStream(tmpPath);
  // Armed BEFORE the sweep, so an output-stream error at any moment lands in the catch below
  // instead of surfacing as an unhandled 'error' event.
  const finished = new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
  });
  finished.catch(() => undefined); // observed here; awaited — and rethrown — below
  const verdictsTmp = verdictsPath === null ? null : verdictsPath + '.tmp';
  const verdicts = verdictsTmp === null ? undefined : createWriteStream(verdictsTmp);
  const verdictsDone = verdicts === undefined
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        verdicts.on('error', reject);
        verdicts.on('finish', resolve);
      });
  verdictsDone.catch(() => undefined);
  try {
    const report = await sweepStream(createReadStream(inPath, { encoding: 'utf8' }), out, fields, verdicts);
    out.end();
    await finished;
    if (verdicts !== undefined) {
      verdicts.end();
      await verdictsDone;
    }
    writeFileSync(reportPath, JSON.stringify({ input: basename(inPath), ...report }, null, 2) + '\n');
    const mdPath = reportPath.endsWith('.json') ? reportPath.slice(0, -'.json'.length) + '.md' : reportPath + '.md';
    writeFileSync(mdPath, renderReport(report, `Story corpus sweep — ${basename(inPath)}`));
    renameSync(tmpPath, outPath); // the kept file exists only once the sweep AND both reports have succeeded
    if (verdictsTmp !== null && verdictsPath !== null) renameSync(verdictsTmp, verdictsPath);
    console.log(`${report.total} records: ${report.kept} kept, ${report.total - report.kept} dropped -> ${outPath}`);
    console.log(`report: ${reportPath} + ${mdPath}`);
    if (verdictsPath !== null) console.log(`verdicts: ${verdictsPath}`);
  } catch (err) {
    out.destroy();
    verdicts?.destroy();
    if (verdictsTmp !== null) rmSync(verdictsTmp, { force: true });
    rmSync(tmpPath, { force: true }); // never leave a partial kept file: the recipe skips the sweep when the kept file exists
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
