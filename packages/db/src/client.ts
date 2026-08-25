/**
 * The database port.
 *
 * Deliberately tiny: `query` and `transaction`, nothing else. Two things follow
 * from that.
 *
 * First, repositories are written against a port rather than against the driver,
 * so the persistence layer stays testable without mocking a database — and
 * mocking a database tests the mock. The port kept a second implementation for a
 * while (PGlite, Postgres compiled to WASM, in-process); it was removed on
 * 2026-08-25 because it could not run pgvector and the suite was therefore
 * exercising a shimmed schema. Tests now run against the real server.
 *
 * Second, there is no query builder. The schema is a compliance artifact that an
 * auditor reads as SQL, so the queries are SQL too, and a reviewer can diff a
 * repository against `chittu-schema.sql` line by line.
 */

export interface QueryResult<R> {
  readonly rows: R[];
}

export interface Db {
  query<R = Record<string, unknown>>(
    sql: string, params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface DbPool extends Db {
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Row-level security
// ---------------------------------------------------------------------------

/**
 * Every child-scoped read and write must run inside here.
 *
 * RLS filters on `current_setting('chittu.child_id')`, and `SET LOCAL` only
 * applies inside a transaction — outside one it is a no-op that Postgres does
 * not even warn about loudly. So a scoped query outside a transaction would see
 * NOTHING and return successfully, which is the silent-empty-result failure this
 * project has already been bitten by once (`revoke_and_erase`).
 *
 * Making the scope the only way to obtain a child-scoped handle means that
 * mistake cannot be made by forgetting a line.
 */
export async function withChildScope<T>(
  pool: DbPool,
  childId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (tx) => {
    // set_config, not SET LOCAL: SET LOCAL cannot take a bound parameter, and
    // interpolating a child id into SQL is exactly the habit not to build.
    await tx.query('SELECT set_config($1, $2, true)', ['chittu.child_id', childId]);
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------
// node-postgres
// ---------------------------------------------------------------------------

export interface PgOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
  /**
   * Raw libpq options applied to EVERY connection, e.g.
   * `-c search_path=test_ab12`. Set per-connection rather than per-session
   * because a pool hands out new connections at will, and a search_path set on
   * one of them is not set on the next.
   */
  readonly options?: string;
}

/** Production. Lazily imports `pg` so tests never load a driver they do not use. */
export async function createPgPool(opts: PgOptions): Promise<DbPool> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'chittu-api',
    ...(opts.options ? { options: opts.options } : {}),
  });
  return {
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          async query(sql, params) {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows };
          },
        });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}
