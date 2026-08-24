# Database

## Migrations before and after first deployment

**Nothing is deployed yet, so `docs/chittu-schema.sql` is the single source of
truth and `0001_init.sql` is generated from it.** A change goes into the schema
file and 0001 is regenerated. That keeps the reviewed compliance artifact and the
thing that actually runs from drifting apart, which they did within one session
of having two files.

**The moment a database exists that we cannot drop, this inverts:** 0001 freezes,
migrations become strictly additive and append-only, and the schema file becomes a
generated snapshot instead. Do not carry the current habit past that point.

Migrations are **plain SQL**, applied in filename order. The schema is a compliance
artifact — an auditor reads it directly — so it is authored in SQL rather than generated
from a query builder. Drizzle is used for *typed queries over* this schema, never to
author it.

```bash
pnpm db:migrate          # apply pending migrations
pnpm db:migrate:status   # what is applied, what is pending
```

## Before you alter a table

Four invariants are enforced here rather than in application code, because "we'll
remember" is not a control an auditor accepts:

1. `flag` has **no free-text column** — only an FK to vetted phrasing
2. `memory_category` is an enum of exactly the six allowlisted values
3. `CHECK (band <> 'thinker' OR body_enc IS NULL)` — a teen's message body is unstorable
4. `audit_event` triggers raise on UPDATE and DELETE

Removing one of these is a Guardian Council decision, not a migration.

## Verification — two lanes, one suite

```bash
pnpm test        # PGlite: real Postgres (WASM), in-process, no container
pnpm db:up       # Postgres 16 + pgvector via Docker/OrbStack
pnpm test:pg     # the SAME suite against the real server
pnpm db:down
```

The second lane is not a different suite. `createTestDb()` picks the engine from
`DATABASE_URL`, so the strict lane is a re-run of the same assertions with three things
the fast lane cannot provide:

| | PGlite | Real server |
|---|---|---|
| Constraints, triggers, RLS, plpgsql | ✅ genuine | ✅ genuine |
| pgvector — `CREATE EXTENSION`, `vector(1024)`, HNSW | ❌ shimmed out | ✅ executed |
| Connection pooling, `SET ROLE` per connection | ❌ single connection | ✅ |
| Named schemas (`GRANT USAGE ON SCHEMA`) | ❌ always `public` | ✅ |

The last two rows are not hypothetical. Running the strict lane found that the schema
never granted `USAGE ON SCHEMA` — invisible in `public`, which grants it to PUBLIC by
default, and fatal in any other schema. It also found an RLS test that silently ran as
superuser because `SET ROLE` is per-connection and the pool handed out a different one.

Each fixture on a real server gets its own throwaway schema, so test files run in
parallel against one database.
