/**
 * One database fixture, one engine.
 *
 * The suite runs against a real Postgres 16 + pgvector — the same server, the
 * same SQL, the same constraints and the same RLS as production. `pnpm test`
 * brings the container up itself; `pnpm db:up` does it by hand.
 *
 * This used to fall back to PGlite — Postgres compiled to WASM, in-process, no
 * container — when DATABASE_URL was absent. That was removed on 2026-08-25.
 * PGlite has no pgvector build, so three statements were stripped from every
 * default run (`CREATE EXTENSION vector`, the `vector(1024)` column, the HNSW
 * index): the default lane tested a schema that was not the one that ships. The
 * `supportsVector` flag that existed so a test could handle the difference was
 * read by nothing, so the divergence was silent. And the fallback was not even
 * buying speed — 207 DB-backed tests took 48.4s on PGlite against 38.3s on the
 * container.
 *
 * Each fixture gets its OWN SCHEMA, so test files run in parallel against one
 * database without colliding.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPgPool, type DbPool } from './client.js';

export interface TestDb {
  readonly pool: DbPool;
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

export async function createTestDb(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestDb> {
  const url = env['DATABASE_URL'];
  // Named before any connection attempt. A fixture that instead failed with
  // ECONNREFUSED would report as "the database is broken" when the actual state
  // is "no database was asked for" — and it would report it once per test file.
  if (!url) {
    throw new Error(
      'DATABASE_URL is required — the test suite runs on a real Postgres and '
      + 'there is no in-process fallback any more.\n'
      + '  pnpm test          brings the container up itself\n'
      + '  pnpm db:up         starts it by hand (postgres on :55432)\n'
      + '  then DATABASE_URL=postgres://chittu:chittu@localhost:55432/chittu_test',
    );
  }

  // A throwaway schema per fixture, so parallel test files do not collide.
  const schema = `t_${randomBytes(5).toString('hex')}`;
  // With DATABASE_URL defaulted in vitest.config.ts, "unset" is no longer the
  // failure anyone actually hits — "the container is not running" is. Left bare
  // that arrives as ECONNREFUSED once per test file, which reads as a broken
  // suite rather than a missing prerequisite.
  let admin;
  try {
    admin = await createPgPool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      throw new Error(
        `cannot reach Postgres at ${new URL(url).host} — start it with `
        + '`pnpm db:up`, or run `pnpm test`, which does that for you.',
        { cause: e },
      );
    }
    throw e;
  }
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
    pool,
    async exec(sql) { await pool.query(sql); },
    async close() {
      const drop = await createPgPool({ connectionString: url, max: 1 });
      await drop.query(`DROP SCHEMA ${schema} CASCADE`);
      await drop.close();
      await pool.close();
    },
  };
}
