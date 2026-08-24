/**
 * The database port.
 *
 * Deliberately tiny: `query` and `transaction`, nothing else. Two things follow
 * from that.
 *
 * First, repositories are written against an interface that BOTH node-postgres
 * and PGlite satisfy, so the whole persistence layer is tested against real
 * Postgres (compiled to WASM) with no server to start and no container in CI.
 * The alternative — mocking a database — tests the mock.
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

// ---------------------------------------------------------------------------
// PGlite — real Postgres, no server
// ---------------------------------------------------------------------------

export interface PgliteHandle {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  }) => Promise<T>): Promise<T | undefined>;
  close(): Promise<void>;
}

/**
 * Wraps an already-created PGlite instance. The instance is passed in rather
 * than constructed here so that `@electric-sql/pglite` stays a dev dependency of
 * whoever is testing, and never reaches a production bundle.
 */
export function wrapPglite(pg: PgliteHandle): DbPool {
  return {
    async query(sql, params) {
      const r = await pg.query(sql, params as unknown[]);
      return { rows: r.rows as never[] };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const out = await pg.transaction(async (tx) => fn({
        async query(sql, params) {
          const r = await tx.query(sql, params as unknown[]);
          return { rows: r.rows as never[] };
        },
      }));
      // PGlite types transaction() as possibly-undefined because a rollback
      // produces no value — but a rollback THROWS, so control never reaches
      // here in that case. A callback that legitimately returns void is common
      // (a write-only transaction), so undefined is passed through rather than
      // treated as an error.
      return out as T;
    },
    async close() { await pg.close(); },
  };
}
