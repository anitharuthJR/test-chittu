# Database

## Running the whole thing locally

**No container and no credentials are needed.** Two terminals from the repo root:

```bash
pnpm install
pnpm dev                      # API on :8080  (apps/api — tsx watch src/main.ts)
```

```bash
pnpm --filter @chittu/web dev # client on :5173, proxying /v1 and /health to :8080
```

Then open **http://localhost:5173**. Check the API separately with:

```bash
curl localhost:8080/health    # {"status":"ok"}
```

There is no migration step. `bootstrapDb()` builds the schema on start, so the
first thing the API prints is how it is running:

```
[chittu] no DATABASE_URL — using an in-process PGlite database. Real Postgres,
         but it vanishes when this process exits.
[chittu] no ANTHROPIC_API_KEY — using the offline stub router. Every turn
         classifies SAFE and the sandbox echoes a fixed reply.
```

**Read the second line before you trust anything you see.** With no key there is
no classifier: L2 returns SAFE for every turn, so the only real guards running
are L1, the deterministic engines and L6. A local session that looks safe is not
evidence that it is — it is evidence that nothing was asked. Export
`ANTHROPIC_API_KEY` to exercise the real router. The API *refuses to start*
without one when `NODE_ENV=production`, so this fallback cannot reach a child.

### Getting past the consent gate

Law 02 is enforced in the client before the router is built, so there is no chat
to reach until a consent record exists. Locally, pick **`dev_stub`** — the only
method that completes without a real integration:

```bash
curl 'localhost:8080/v1/consent/methods?country=IN'
# methods: ["signed_form_review", "dev_stub"]
```

`dev_stub` is a development affordance, not a consent method. G1 stays red until
a real adapter completes; see `packages/consent/src/adapters.ts` for what each one
is blocked on.

### Where the logs are

```
logs/api.log          # JSON, one object per line — always at the REPO ROOT
```

Created on boot and announced in the first lines of output. It is the same
stream as the console, not a subset. Configure with:

| | |
|---|---|
| `LOG_DIR=/some/path` | write there instead |
| `LOG_DIR=` (empty) | stdout only — what containers want |
| `LOG_LEVEL=debug` | default is `info` |

`logs/` is gitignored, and **it is not the audit trail** — that is the seal
chain, in Postgres. A file on a task that can be replaced at any moment is not a
record anyone can rely on; §14 ships stdout to a log group in production.

**Message bodies are redacted, and that is enforced rather than hoped for.**
Architecture §2.2 says a child's words never enter a log line. Until 2026-08-24
that held only by accident — Fastify's default serialisers happen to omit
bodies, so the first person to log `req.body`, or an error object carrying the
turn that caused it, would have written a child's words to disk with nothing
objecting. `apps/api/src/logging.ts` now names the fields that can carry them
and `logging.test.ts` drives real pino to prove they are censored.

```bash
tail -f logs/api.log | pnpm exec pino-pretty   # if you want it readable
```

### With real Postgres instead of PGlite

Only needed for pgvector, genuine concurrency, or pooling behaviour — see
*Verification* below for why those three differ:

```bash
pnpm db:up
DATABASE_URL=postgres://chittu:chittu@localhost:55432/chittu_test pnpm dev
pnpm db:down
```

### The prototype needs none of this

`prototype/chittu-v3.html` is a single file with no build step — open it directly.
It is still the reference implementation, and it calls the Anthropic API from the
browser, which is why it is a lab artefact and not a product.

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

**There is no migration CLI yet, and `pnpm db:migrate` does not exist** — this
file claimed it did until 2026-08-24. Migrations are applied at startup by
`applyMigrations()` in `apps/api/src/db-bootstrap.ts`, which reads
`db/migrations/*.sql` in filename order and runs every one on each boot. That is
fine while `0001_init.sql` is regenerated from the schema and nothing is deployed;
it stops being fine the moment migrations must be additive and applied once, which
is the same inversion described above. A real runner is part of that change, not
before it.

For PGlite the pgvector DDL is rewritten on the way through — `vector(1024)`
becomes `real[]` and the HNSW index is dropped — so corpus-embedding behaviour is
the one thing the fast lane does not actually exercise.

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
