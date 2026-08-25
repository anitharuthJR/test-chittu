/**
 * Apply migrations to a real Postgres, then exit.
 *
 *   pnpm db:migrate                                  # uses DATABASE_URL
 *   DATABASE_URL=postgres://… pnpm db:migrate
 *
 * WHY THIS EXISTS, which is not a nice-to-have.
 *
 * `bootstrapDb()` applies migrations on the PGlite path and NOT on the Postgres
 * path. So pointing the API at a real database gave an empty schema — and it
 * started, and reported healthy, because `/health` is `SELECT 1` and an empty
 * database answers that perfectly well. Containerising surfaced it: on a laptop
 * nobody sets DATABASE_URL, so the gap had never been on a path anyone ran.
 *
 * WHY IT IS A SEPARATE STEP rather than something bootstrapDb does for Postgres
 * too: db/README's rule is that once a database exists that we cannot drop,
 * migrations become strictly additive and applied once. A service that migrates
 * on every boot is the opposite of that, and would run N times concurrently the
 * first time the API scales past one task. Deployments run a migration task
 * BEFORE the service; this is that task.
 *
 * WHY THERE IS A LEDGER. `applyMigrations()` runs every .sql file it finds, every
 * time. That is harmless on PGlite, which starts empty on every boot — and fatal
 * on Postgres, where the second run dies with `relation "deployment" already
 * exists`. The first `pnpm stack:up` worked and the second failed, which is
 * exactly the shape of a bug that reaches production as "the redeploy broke".
 * So this tracks what it has applied and skips it next time.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPgPool, deploymentEnv } from '@chittu/db';
import { loadEnvLocal } from './env-local.js';

// Before DATABASE_URL is read, so `pnpm db:migrate` picks up the same local
// configuration the API does. No-op in production and when the file is absent.
loadEnvLocal();

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error(
    'DATABASE_URL is required.\n'
    + 'Without one the API uses PGlite, which migrates itself at boot and needs '
    + 'nothing from this script.',
  );
  process.exit(2);
}

const dir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const pool = await createPgPool({ connectionString: url });
try {
  // The ledger itself is the one thing that must be safe to re-run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migration',
  );
  const done = new Set(rows.map((r) => r.filename));

  let applied = 0;
  for (const f of files) {
    if (done.has(f)) {
      console.log(`[chittu] skip ${f} — already applied`);
      continue;
    }
    // Each migration and its ledger row land together or not at all. Without the
    // transaction a migration that half-applies leaves a database that is
    // neither migrated nor recorded as unmigrated, which is the worst of both.
    await pool.transaction(async (tx) => {
      await tx.query(readFileSync(dir + f, 'utf8'));
      await tx.query('INSERT INTO schema_migration (filename) VALUES ($1)', [f]);
    });
    console.log(`[chittu] applied ${f}`);
    applied++;
  }

  // The PGlite path seeds this too. Without it every insert referencing a
  // deployment fails, which looks like a bug in the first feature anyone tries
  // rather than an empty lookup table. ON CONFLICT so re-running is safe.
  const env = deploymentEnv();
  await pool.query(
    `INSERT INTO deployment (env, region) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [env, process.env['AWS_REGION'] ?? 'ap-south-1'],
  );

  const { rows: t } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  console.log(
    `[chittu] migrations up to date — ${applied} applied this run, `
    + `${files.length} known, ${t[0]?.n ?? '?'} tables present`,
  );
} finally {
  await pool.close();
}
