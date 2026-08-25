/**
 * Getting a database, for whoever is asking.
 *
 * One driver, one engine: node-postgres against a real Postgres 16 + pgvector.
 * There used to be a second — PGlite, Postgres compiled to WASM and run
 * in-process — so that `pnpm start` and the suite needed no container. It was
 * removed on 2026-08-25, for three reasons worth keeping written down:
 *
 *   1. It could not run pgvector, so `CREATE EXTENSION vector`, the
 *      `vector(1024)` column and the HNSW index were shimmed out of every
 *      default run. The schema under test was not the schema that ships.
 *   2. The escape hatch built for that — `TestDb.supportsVector`, so a test
 *      could assert on the real thing and skip otherwise — was read by no test.
 *      The divergence was silent, not handled.
 *   3. It was not faster. 207 DB-backed tests: 48.4s on PGlite, 38.3s on a
 *      container. WASM overhead cost more than Docker does.
 *
 * So the absence of DATABASE_URL is now an error everywhere rather than a
 * fallback in development. See docs/superpowers/specs/2026-08-25-remove-pglite-design.md.
 *
 * NO KEY PROVIDER HERE — see `keys/index.ts` for why.
 *
 * Briefly: `providers/cli.ts` and `helplines/cli.ts` call this and use only the
 * pool. Building keys here would make the helpline sweep — the GAP-06 P0 path —
 * refuse to start in production over a key it never touches.
 *
 * AND NO MIGRATIONS HERE, which is a separate rule with its own reason:
 * db/README's is that once a database exists we cannot drop, migrations are
 * strictly additive and applied once. A service that migrates on boot runs N
 * times concurrently the first time it scales past one task. Deployments run a
 * migration task BEFORE the service; `migrate.ts` is that task, and it keeps a
 * ledger so a redeploy is not a second run. This function only connects.
 */
import { createPgPool, type DbPool } from '@chittu/db';

export interface Bootstrapped {
  readonly pool: DbPool;
}

export async function bootstrapDb(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Bootstrapped> {
  const url = env['DATABASE_URL'];
  // Checked before any connection is opened, so the failure is legibly about
  // configuration. Surfacing it as ECONNREFUSED instead sends the reader to
  // look at the database when the database was never named.
  if (!url) {
    throw new Error(
      'DATABASE_URL is required — there is no in-process fallback database any '
      + 'more.\n'
      + '  dev:   pnpm db:up  (or `pnpm start`, which brings its own up)\n'
      + '  tests: pnpm test   (brings up postgres on :55432)\n'
      + '  e.g.   DATABASE_URL=postgres://chittu:chittu@localhost:55433/chittu',
    );
  }
  return { pool: await createPgPool({ connectionString: url }) };
}
