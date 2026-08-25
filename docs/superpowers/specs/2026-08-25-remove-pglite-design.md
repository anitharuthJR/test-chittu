# Remove PGlite; run everything on real Postgres

**Date:** 2026-08-25
**Status:** approved

## Why

The repo runs two database drivers behind one port: node-postgres when
`DATABASE_URL` is set, PGlite (Postgres compiled to WASM, in-process) otherwise.
The second driver was there to keep `pnpm start` and the test suite
container-free.

Three things argue against keeping it:

1. **The schema diverges.** PGlite has no pgvector build, so `shimVector()`
   strips three statements — `CREATE EXTENSION vector`, the `vector(1024)` column
   and the HNSW index. The default test lane has therefore never executed the
   corpus DDL.
2. **The escape hatch it bought is unused.** `TestDb.supportsVector` exists so a
   test can assert on pgvector when present and skip when absent. **No test reads
   it.** The divergence is silent rather than handled.
3. **It is not even faster.** Measured on the four heaviest DB-backed files
   (207 tests) on 2026-08-25:

   | Engine | Wall | Test execution |
   |---|---|---|
   | PGlite | 48.41s | 119.08s |
   | Postgres 16 + pgvector (container) | **38.29s** | **52.02s** |

   WASM overhead costs more than the container does.

## Decisions

- **Scope:** full removal — runtime *and* tests. `@electric-sql/pglite` leaves
  the dependency tree.
- **Topology:** keep compose.yaml's two services. `postgres` (tmpfs, 55432,
  `chittu_test`) for the suite; `postgres-dev` (volume, 55433, `chittu`) for dev.
  The tmpfs/persistence split is deliberate and stays.
- **Container lifecycle:** `dev.sh` and `pnpm test` start their container
  themselves, matching how `dev.sh` already runs `pnpm install` on first run.

## Changes

### Runtime — `apps/api/src/db-bootstrap.ts`
`bootstrapDb()` collapses to one branch; `DATABASE_URL` is required
unconditionally, and the error names `pnpm db:up`. Deleted: the `PgliteLoader`
injection point, the `ERR_MODULE_NOT_FOUND` rescue, the `driver` field, and
`applyMigrations()` — whose only caller was the PGlite branch.

The invariant that `bootstrapDb` does **not** migrate the Postgres path is
preserved. It only ever migrated on the PGlite side, which is the gap
`migrate.ts` exists to close. `migrate.ts` keeps its own ledgered loop and is
otherwise untouched.

### Test fixture — `packages/db/src/testing.ts`
Same collapse; `DATABASE_URL` required, error names `pnpm db:up`. Deleted:
the PGlite branch, `shimVector()`, `supportsVector`, `driver`.

**Retained** — real-Postgres concurrency machinery, not PGlite scaffolding:
the per-fixture `t_<hex>` schema, `CREATE EXTENSION … SCHEMA public`, and the
`pg_advisory_xact_lock(4021)` that makes `IF NOT EXISTS` atomic across parallel
fixtures on a cold database.

### `packages/db/src/client.ts`
Delete `wrapPglite()` and `PgliteHandle`. Drop `@electric-sql/pglite` from the
root, `apps/api` and `packages/db` package.json files.

### `scripts/dev.sh`
Bring up `postgres-dev` via `docker compose --profile dev up -d --wait
postgres-dev`, run `pnpm db:migrate`, export `DATABASE_URL`, then launch. Refuse
with a clear message if Docker is not running. Banner reports the real URL.

### Test + verify plumbing
`pretest` runs `pnpm db:up`; `test` sets `DATABASE_URL` to the 55432 test
database. `test:pg` is deleted as redundant. In `verify.sh` the `--with-pg` flag
is removed — the Postgres lane is now the default lane. `--with-container` is
unaffected.

### Docs and comments
`.env.example`, `CLAUDE.md`, `db/README.md`, `compose.yaml`,
`docs/chittu-status.md`, `PORT-REVIEW.md`, and the eight incidental comments
asserting "tests use PGlite".

## Explicitly out of scope

`toBuffer()` (`consent-repo.ts`) and the explicit-placeholder query
(`clearance.ts`) both work around PGlite driver quirks and are now unnecessary.
One is in the crypto path, the other in provider clearance. Churning either for
zero functional gain is a bad trade. Comments get rewritten to say they are
defensive rather than required; the code stays.

## Accepted cost

`pnpm test` stops working without Docker, and that suite is the whole quality
gate since GitHub Actions was removed on 2026-08-25. Accepted deliberately.

## Verification

- `pnpm verify` end to end.
- Mutation checks on the new guards: with `DATABASE_URL` unset, `bootstrapDb`
  and `createTestDb` must each refuse with a message naming `pnpm db:up` —
  not an `ECONNREFUSED` stack and not a silent hang.
- `pnpm start` in a clean worktree: container comes up, migrations apply,
  consent → session → maths → model → crisis all pass.
