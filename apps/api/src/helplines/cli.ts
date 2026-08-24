/**
 * Ops commands for the helpline registry.
 *
 * A runbook whose steps are "ask an engineer" is not a runbook. These are the
 * four things `docs/runbooks/helpline-p0.md` tells someone to do, so they can
 * actually do them.
 *
 *   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts list
 *   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts import
 *   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts verify IN you@tulifo.ai [days]
 *   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts p0 IN you@tulifo.ai
 *   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts sweep
 */

import { COUNTRIES, type Country } from '@chittu/contracts';
import { REGISTRY } from '@chittu/safety-kernel';
import { helplineRepo } from '@chittu/db';
import { bootstrapDb } from '../db-bootstrap.js';
import { runSweep } from './sweep.js';

const DEFAULT_SWEEP_DAYS = 30;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * Importing is NOT verifying.
 *
 * Rows land with `next_sweep = now()`, so the very next sweep marks them stale
 * and pages someone. Writing `verified` with today's date would be the exact
 * lie this table exists to prevent — a registry that looks checked because a
 * script ran.
 */
async function importBuiltin(): Promise<void> {
  const { pool } = await bootstrapDb();
  const repo = helplineRepo(pool);
  for (const country of COUNTRIES) {
    const r = REGISTRY[country];
    await repo.upsert(
      pool, country,
      r.lines.map((l) => ({ name: l.name, number: l.contact })),
      'import:builtin (UNVERIFIED)',
      new Date(),
    );
    console.log(`imported ${country}: ${r.lines.length} lines — UNVERIFIED, due now`);
  }
  console.log('\nThese are the shipped numbers, not checked numbers.');
  console.log('Run `sweep` and then `verify <country> <you>` for each.');
  await pool.close();
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'import') return importBuiltin();

  const { pool } = await bootstrapDb();
  const repo = helplineRepo(pool);

  switch (cmd) {
    case 'list': {
      const rows = await repo.listAll(pool);
      if (rows.length === 0) {
        console.log('registry is EMPTY — every market is running on the shipped fallback.');
        break;
      }
      for (const r of rows) {
        const mark = r.status === 'verified' ? '  ' : r.status === 'stale' ? '! ' : '!!';
        console.log(
          `${mark} ${r.country.padEnd(3)} ${r.status.padEnd(17)} `
          + `next ${r.nextSweep.slice(0, 10)}  by ${r.verifiedBy}`);
        for (const l of r.lines) console.log(`      ${l.name}: ${l.number}`);
      }
      break;
    }

    case 'verify': {
      const [country, by, days] = args;
      if (!country || !by) throw new Error('usage: verify <COUNTRY> <who@> [days]');
      await repo.markVerified(
        pool, country.toUpperCase(), by,
        inDays(days ? Number(days) : DEFAULT_SWEEP_DAYS));
      console.log(`${country.toUpperCase()} verified by ${by}; next check in `
        + `${days ?? DEFAULT_SWEEP_DAYS} days.`);
      break;
    }

    case 'p0': {
      const [country, by] = args;
      if (!country || !by) throw new Error('usage: p0 <COUNTRY> <who@>');
      await repo.flagP0(pool, country.toUpperCase(), by);
      console.log(
        `${country.toUpperCase()} flagged P0_WRONG_NUMBER. Children now get the `
        + `shipped fallback numbers. Fix the lines, then run verify.`);
      break;
    }

    case 'sweep': {
      const r = await runSweep(pool);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    default:
      console.log('commands: list | import | verify | p0 | sweep');
  }
  await pool.close();
}

await main();
