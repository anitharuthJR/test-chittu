/**
 * Getting a database, for whoever is asking.
 *
 * Two DRIVERS behind one port — not two code paths. node-postgres when a
 * DATABASE_URL exists, PGlite otherwise. PGlite is real Postgres compiled to
 * WASM, so `pnpm dev` and CI run the same SQL, the same constraints and the same
 * RLS as production; only the transport differs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPgPool, wrapPglite, localKeyProvider, devMasterKeyFromEnv,
  type DbPool, type KeyProvider } from '@chittu/db';

export interface Bootstrapped {
  readonly pool: DbPool;
  readonly keys: KeyProvider;
  readonly driver: 'postgres' | 'pglite';
}

/** Apply every migration in order, with the pgvector DDL shimmed for PGlite. */
export async function applyMigrations(
  exec: (sql: string) => Promise<unknown>, forPglite: boolean,
): Promise<void> {
  const dir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    let sql = readFileSync(dir + f, 'utf8');
    if (forPglite) {
      // PGlite has no pgvector build; the corpus DDL is the only casualty
      sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS vector;.*\n/, '')
               .replace(/vector\(1024\)/g, 'real[]')
               .replace(/CREATE INDEX corpus_chunk_ann[\s\S]*?;\n/, '');
    }
    await exec(sql);
  }
}

/**
 * How the PGlite module is obtained. Injectable for ONE reason: the interesting
 * failure is "this image has no PGlite in it", and that is not reproducible in
 * a test run where it is installed.
 */
export type PgliteLoader = () => Promise<typeof import('@electric-sql/pglite')>;

export async function bootstrapDb(
  env: NodeJS.ProcessEnv = process.env,
  loadPglite: PgliteLoader = () => import('@electric-sql/pglite'),
): Promise<Bootstrapped> {
  const keys = localKeyProvider(devMasterKeyFromEnv(env), env['NODE_ENV'] ?? 'dev');
  const url = env['DATABASE_URL'];
  if (url) {
    return { pool: await createPgPool({ connectionString: url }), keys, driver: 'postgres' };
  }
  if (env['NODE_ENV'] === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  // PGlite is a devDependency, so it is absent from the production image. That
  // is correct — a WASM Postgres has no business shipping to production — but
  // reaching this line in such an image produced a bare ERR_MODULE_NOT_FOUND
  // stack, which names the package and not the actual mistake: no DATABASE_URL.
  // Anything else that goes wrong is re-thrown untouched.
  let PGlite;
  try {
    ({ PGlite } = await loadPglite());
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw e;
    throw new Error(
      'no DATABASE_URL, and @electric-sql/pglite is not installed in this '
      + 'environment — which is what a production image looks like, since PGlite '
      + 'is a devDependency. Set DATABASE_URL to a real Postgres.',
      { cause: e },
    );
  }
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await applyMigrations((sql) => pg.exec(sql), true);
  await pg.exec(`INSERT INTO deployment (env, region) VALUES ('dev','ap-south-1')`);
  return { pool: wrapPglite(pg as never), keys, driver: 'pglite' };
}
