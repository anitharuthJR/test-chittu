/**
 * One database fixture, two engines.
 *
 * Without `DATABASE_URL` the suite runs on PGlite — real Postgres compiled to
 * WASM, in-process, no container. With `DATABASE_URL` set it runs on a real
 * server. **The same tests, the same SQL, the same assertions**, so the second
 * engine is a stricter re-run rather than a separate suite that drifts.
 *
 * The difference that matters is pgvector: PGlite has no build of it, so three
 * statements — `CREATE EXTENSION vector`, the `vector(1024)` column and the HNSW
 * index — are shimmed out there and are the only part of the schema that a
 * PGlite-only run never executes. `supportsVector` says which run you are in, so
 * a test can assert on the real thing when it is available and skip when it is
 * not, instead of quietly pretending.
 *
 * On a real server each fixture gets its OWN SCHEMA, so test files can run in
 * parallel against one database without colliding.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPgPool, wrapPglite, type DbPool } from './client.js';

export interface TestDb {
  readonly pool: DbPool;
  readonly driver: 'postgres' | 'pglite';
  /** False on PGlite: the vector DDL was shimmed out of this run. */
  readonly supportsVector: boolean;
  /** Run a statement outside the pool abstraction — `SET ROLE`, `RESET`, etc. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function migrationFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(dir + f, 'utf8'));
}

/** PGlite cannot do pgvector; strip exactly those statements and nothing else. */
function shimVector(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS vector;.*\n/, '')
    .replace(/vector\(1024\)/g, 'real[]')
    .replace(/CREATE INDEX corpus_chunk_ann[\s\S]*?;\n/, '');
}

export async function createTestDb(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestDb> {
  const url = env['DATABASE_URL'];

  if (url) {
    // A throwaway schema per fixture, so parallel test files do not collide.
    const schema = `t_${randomBytes(5).toString('hex')}`;
    const admin = await createPgPool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.close();

    const pool = await createPgPool({
      connectionString: url,
      options: `-c search_path=${schema},public`,
      applicationName: 'chittu-test',
    });
    // SCHEMA public, explicitly. An extension is created into the FIRST schema
    // on the search_path, so without this the `vector` type lands in whichever
    // throwaway schema happened to run first — and every later fixture fails
    // with `type "vector" does not exist`, because IF NOT EXISTS then finds the
    // extension already present and creates nothing. `public` is on every
    // fixture's search_path, so that is where shared types belong.
    // UNDER AN ADVISORY LOCK, because `IF NOT EXISTS` is not atomic. Two
    // fixtures starting at the same moment on a FRESH database both see "not
    // present" and both create, and one loses with
    // `duplicate key value violates unique constraint "pg_extension_name_index"`
    // — reported as a whole test FILE failing at collection, every test in it
    // skipped, intermittently.
    //
    // It only reproduces on a database nobody has used yet, which is exactly
    // what `pnpm db:up` makes and exactly what a rerun does not: three
    // consecutive green runs against a warm database said nothing about it.
    // The lock is transaction-scoped, so it releases on commit with no cleanup
    // path to forget.
    await pool.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(4021)');
      await tx.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
      await tx.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public');
    });
    for (const sql of migrationFiles()) await pool.query(sql);
    await pool.query(
      `INSERT INTO deployment (env, region) VALUES ('dev','ap-south-1')`);

    return {
      pool, driver: 'postgres', supportsVector: true,
      async exec(sql) { await pool.query(sql); },
      async close() {
        const drop = await createPgPool({ connectionString: url, max: 1 });
        await drop.query(`DROP SCHEMA ${schema} CASCADE`);
        await drop.close();
        await pool.close();
      },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  for (const sql of migrationFiles()) await pg.exec(shimVector(sql));
  await pg.exec(`INSERT INTO deployment (env, region) VALUES ('dev','ap-south-1')`);

  return {
    pool: wrapPglite(pg as never),
    driver: 'pglite',
    supportsVector: false,
    async exec(sql) { await pg.exec(sql); },
    async close() { await pg.close(); },
  };
}
