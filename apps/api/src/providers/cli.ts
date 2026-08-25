/**
 * Ops commands for routing.
 *
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts catalogue
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts show
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts set <category> <provider:model> <who> "<reason>" [--country IN] [--band thinker]
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts show [--country IN] [--band thinker]
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts history [category]
 *
 * WHY THIS EXISTS RATHER THAN "run this INSERT". The table has CHECK constraints
 * for what SQL can police — a real category, a named person, a reason with
 * content in it — and it deliberately does NOT constrain the model against the
 * catalogue, because that list lives in code. So a hand-written INSERT can land
 * a row that the API reads, rejects at startup and ignores, leaving ops
 * believing a change took effect that never did.
 *
 * This validates against MODEL_CATALOGUE *before* writing. A change that would
 * be refused at startup is refused here, at the keyboard, while the person who
 * typed it is still present.
 */

import { bootstrapDb } from '../db-bootstrap.js';
import {
  MODEL_CATALOGUE, CATEGORIES, readCells, resolveCells, promptVersionFor, cellFor,
} from './cells.js';
import { DEFAULT_CELLS } from './router.js';
import { BANDS, COUNTRIES, type Band, type Country, type RouterCategory } from '@chittu/contracts';

/** `--country IN --band thinker`, pulled out so the positional args stay stable. */
function takeFlags(argv: string[]): { rest: string[]; band?: Band; country?: Country } {
  const rest: string[] = [];
  let band: Band | undefined;
  let country: Country | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--band') {
      const v = argv[++i];
      if (v === undefined || !(BANDS as readonly string[]).includes(v)) {
        fail(`--band must be one of ${BANDS.join(', ')}`);
      }
      band = v as Band;
    } else if (a === '--country') {
      const v = argv[++i];
      if (v === undefined || !(COUNTRIES as readonly string[]).includes(v)) {
        fail(`--country must be one of ${COUNTRIES.join(', ')}`);
      }
      country = v as Country;
    } else rest.push(a);
  }
  return { rest, ...(band ? { band } : {}), ...(country ? { country } : {}) };
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const { rest: argv, band: flagBand, country: flagCountry } = takeFlags(process.argv.slice(2));
const [cmd, ...args] = argv;
const { pool } = await bootstrapDb();

try {
  switch (cmd) {
    case 'catalogue': {
      console.log('Models this build may route to (add one in providers/cells.ts):\n');
      for (const [provider, models] of Object.entries(MODEL_CATALOGUE)) {
        console.log(`  ${provider}`);
        for (const m of models) console.log(`    ${m}`);
      }
      console.log('\nCategories:');
      for (const c of CATEGORIES) {
        console.log(`  ${c.padEnd(12)} prompt version ${promptVersionFor(c)} (not configurable)`);
      }
      break;
    }

    case 'show': {
      const r = resolveCells({ env: process.env, rows: await readCells(pool) });
      const ctx = flagBand !== undefined && flagCountry !== undefined
        ? { band: flagBand, country: flagCountry } : undefined;
      console.log(ctx === undefined
        ? 'Effective routing (unscoped — pass --country and --band for one child):\n'
        : `Effective routing for ${/^[aeiou]/i.test(ctx.band) ? 'an' : 'a'} `
          + `${ctx.band} in ${ctx.country}:\n`);
      for (const c of CATEGORIES) {
        const cell = ctx === undefined ? r.cells[c] : cellFor(r, c, ctx);
        const isDefault = cell.provider === DEFAULT_CELLS[c].provider
          && cell.model === DEFAULT_CELLS[c].model;
        console.log(`  ${isDefault ? ' ' : '*'} ${c.padEnd(12)} ${cell.provider}/${cell.model}`);
      }
      if (ctx === undefined && r.scoped.some((e) => e.band !== null || e.country !== null)) {
        console.log('\nScoped assignments (not shown above — pass --country/--band):');
        for (const e of r.scoped.filter((x) => x.band !== null || x.country !== null)) {
          const scope = [e.country, e.band].filter((x) => x !== null).join('/');
          console.log(`    ${e.category} [${scope}] -> ${e.cell.provider}/${e.cell.model} (${e.origin})`);
        }
      }
      if (r.problems.length > 0) {
        console.log('\nREJECTED — ignored, the compiled default is in use:');
        for (const p of r.problems) console.log(`  ${p}`);
      }
      if (r.dbIgnored) {
        console.log('\nCHITTU_ROUTING_DB=off — provider_cell rows are NOT applied here.');
      }
      break;
    }

    case 'set': {
      const [category, pair, who, ...reasonParts] = args;
      const reason = reasonParts.join(' ');
      if (category === undefined || pair === undefined || who === undefined || reason === '') {
        fail('usage: set <category> <provider:model> <who> "<reason>"');
      }
      if (!(CATEGORIES as readonly string[]).includes(category)) {
        fail(`"${category}" is not a routing category. Have: ${CATEGORIES.join(', ')}`);
      }
      const at = pair.indexOf(':');
      if (at <= 0) fail(`expected provider:model, got "${pair}"`);
      const provider = pair.slice(0, at);
      const model = pair.slice(at + 1);

      // The check the database cannot make. Refusing here means ops never
      // believes a change landed that the API will silently ignore.
      const models = MODEL_CATALOGUE[provider];
      if (models === undefined) {
        fail(`provider "${provider}" is not in the catalogue. Run \`catalogue\`.`);
      }
      if (!models.includes(model)) {
        fail(`model "${model}" is not catalogued for ${provider}.\n  have: ${models.join(', ')}`);
      }

      const compiled = DEFAULT_CELLS[category as RouterCategory];
      await pool.query(
        `INSERT INTO provider_cell (category, provider, model, changed_by, reason, band, country)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [category, provider, model, who, reason, flagBand ?? null, flagCountry ?? null]);

      const scope = [flagCountry, flagBand].filter((x) => x !== undefined).join('/');
      console.log(`${category}${scope === '' ? ' (all bands, all countries)' : ` [${scope}]`}: ${provider}/${model}`);
      console.log(`  compiled default is ${compiled.provider}/${compiled.model}`);
      console.log(`  by ${who} — ${reason}`);
      console.log('\nTakes effect when the API restarts. Cells are read once at boot,');
      console.log('deliberately: routing that changes under a turn in flight is worse than');
      console.log('routing that needs a restart.');
      break;
    }

    case 'history': {
      const category = args[0];
      const { rows } = await pool.query<{
        category: string; provider: string; model: string; band: string | null;
        country: string | null; changed_by: string; reason: string; changed_at: Date;
      }>(
        category === undefined
          ? `SELECT category, provider, model, band, country, changed_by, reason, changed_at
               FROM provider_cell ORDER BY changed_at DESC LIMIT 50`
          : `SELECT category, provider, model, band, country, changed_by, reason, changed_at
               FROM provider_cell WHERE category = $1 ORDER BY changed_at DESC LIMIT 50`,
        category === undefined ? [] : [category]);
      if (rows.length === 0) { console.log('no routing changes recorded'); break; }
      for (const r of rows) {
        const scope = [r.country, r.band].filter((x) => x !== null).join('/');
        console.log(`${r.changed_at.toISOString()}  ${r.category}${scope === '' ? '' : ` [${scope}]`} `
          + `-> ${r.provider}/${r.model}\n    ${r.changed_by}: ${r.reason}`);
      }
      break;
    }

    default:
      fail('commands: catalogue | show | set | history');
  }
} finally {
  await pool.close();
}
