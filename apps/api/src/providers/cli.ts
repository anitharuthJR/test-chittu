/**
 * Ops commands for routing.
 *
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts catalogue
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts show
 *   pnpm --filter @chittu/api exec tsx src/providers/cli.ts set <category> <provider:model> <who> "<reason>"
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
  MODEL_CATALOGUE, CATEGORIES, readCells, resolveCells, promptVersionFor,
} from './cells.js';
import { DEFAULT_CELLS } from './router.js';
import type { RouterCategory } from '@chittu/contracts';

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const [cmd, ...args] = process.argv.slice(2);
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
      console.log('Effective routing:\n');
      for (const c of CATEGORIES) {
        const cell = r.cells[c];
        const mark = r.origin[c] === 'default' ? ' ' : '*';
        console.log(`  ${mark} ${c.padEnd(12)} ${cell.provider}/${cell.model}  (${r.origin[c]})`);
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
        `INSERT INTO provider_cell (category, provider, model, changed_by, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [category, provider, model, who, reason]);

      console.log(`${category}: ${provider}/${model}`);
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
        category: string; provider: string; model: string;
        changed_by: string; reason: string; changed_at: Date;
      }>(
        category === undefined
          ? `SELECT category, provider, model, changed_by, reason, changed_at
               FROM provider_cell ORDER BY changed_at DESC LIMIT 50`
          : `SELECT category, provider, model, changed_by, reason, changed_at
               FROM provider_cell WHERE category = $1 ORDER BY changed_at DESC LIMIT 50`,
        category === undefined ? [] : [category]);
      if (rows.length === 0) { console.log('no routing changes recorded'); break; }
      for (const r of rows) {
        console.log(`${r.changed_at.toISOString()}  ${r.category.padEnd(12)} `
          + `${r.provider}/${r.model}\n    ${r.changed_by}: ${r.reason}`);
      }
      break;
    }

    default:
      fail('commands: catalogue | show | set | history');
  }
} finally {
  await pool.close();
}
