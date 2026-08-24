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
 * database answers that perfectly well. It was containerising the thing that
 * surfaced this: on a laptop nobody sets DATABASE_URL, so the gap had never
 * been on a path anyone ran.
 *
 * WHY IT IS A SEPARATE STEP rather than something bootstrapDb does for Postgres
 * too: db/README's rule is that once a database exists that we cannot drop,
 * migrations become strictly additive and applied once. A service that migrates
 * on every boot is the opposite of that, and would run N times concurrently the
 * first time the API scales past one task. Deployments run a migration task
 * BEFORE the service; this is that task, in the form the dev stack can use.
 */
import { createPgPool } from '@chittu/db';
import { applyMigrations } from './db-bootstrap.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error(
    'DATABASE_URL is required.\n'
    + 'Without one the API uses PGlite, which migrates itself at boot and needs '
    + 'nothing from this script.',
  );
  process.exit(2);
}

const pool = await createPgPool({ connectionString: url });
try {
  // `false` — this is real Postgres, so the pgvector DDL runs as written rather
  // than being rewritten to real[] the way the PGlite path has to.
  await applyMigrations(async (sql) => { await pool.query(sql); }, false);

  // The PGlite path seeds this too. Without it every insert that references a
  // deployment fails, which looks like a bug in the first feature anyone tries
  // rather than an empty lookup table.
  const env = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
  await pool.query(
    `INSERT INTO deployment (env, region) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [env, process.env['AWS_REGION'] ?? 'ap-south-1'],
  );

  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  console.log(`[chittu] migrations applied — ${rows[0]?.n ?? '?'} tables present`);
} finally {
  await pool.close();
}
