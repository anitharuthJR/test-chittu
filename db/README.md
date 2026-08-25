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

`pnpm start` brings up `postgres-dev`, migrates it, then launches — so the first
thing the API prints is how it is running:

```
[chittu] database: localhost:55433/chittu — Postgres 16 + pgvector
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

### Pointing at a different database

`pnpm start` defaults to the `postgres-dev` container (`:55433/chittu`, volume
backed, left running when you Ctrl-C). Export `DATABASE_URL` to override it —
the script then skips nothing except its own default, and still migrates:

```bash
DATABASE_URL=postgres://user:pw@somewhere:5432/chittu pnpm start
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

**One exception has already been needed, and it is worth knowing why.** On
2026-08-25 a wrong CHECK on `training_signal.shape` was fixed in the schema file
and 0001 regenerated — and that fix reaches a fresh boot and *never* reaches a
Postgres somebody migrated last week, because `pnpm db:migrate` keeps a ledger
and skips a file it has applied. `0005_signal_counter.sql` is the replay for
anything already past 0001: the same changes, written to be a no-op on a
database that came from the new one. Prefer this pattern over hoping nobody has
a dev database.

**The moment a database exists that we cannot drop, this inverts:** 0001 freezes,
migrations become strictly additive and append-only, and the schema file becomes a
generated snapshot instead. Do not carry the current habit past that point.

Migrations are **plain SQL**, applied in filename order. The schema is a compliance
artifact — an auditor reads it directly — so it is authored in SQL rather than generated
from a query builder. Drizzle is used for *typed queries over* this schema, never to
author it.

```bash
DATABASE_URL=postgres://… pnpm db:migrate    # apply to a real Postgres
```

**`pnpm db:migrate` only became real on 2026-08-24, and this file claimed it for
a while before that.** There is still no `db:migrate:status`. (This section was
also duplicated verbatim in this file until 2026-08-25.)

The gap it closes is worth knowing about, because containerising is what found
it: `bootstrapDb()` connects and does not migrate. Point the API at a real
database and you got an empty schema — and it started, and reported healthy,
because `/health` is `SELECT 1` and an empty database answers that perfectly
well. It stayed hidden while a laptop with no `DATABASE_URL` fell back to an
in-process database that migrated itself at boot, so the gap was never on a path
anyone ran. That fallback was removed on 2026-08-25 and `pnpm start` now runs
this script on every launch, which puts it on everyone's path.

Migration stays a **separate step**, not something the service does at boot. A
service that migrates on start runs N times concurrently the first time it scales
past one task, and that is the opposite of the additive, applied-once rule above.
Deployments run a migration task before the service; `compose.yaml`'s `dev`
profile rehearses exactly that shape, and so does `scripts/dev.sh`.

## The container, and the dev stack

```bash
pnpm stack:up      # postgres + migrate + api, all in Docker
pnpm stack:logs
pnpm stack:down
```

The smallest honest rehearsal of §14's topology available without AWS: the API in
its own image, against real Postgres with real pgvector, migrated by a task that
runs to completion before the service starts. Verified from an empty volume — 33
tables, `vector(1024)` as a genuine type.

It is a **profile**, so plain `docker compose up -d` still means "the test
database, nothing else" — which is what `pnpm test` starts.

Two things about the image are deliberate and both are arguable:

- **It runs TypeScript through `tsx`; it does not compile.** Every package points
  `main` at `src/index.ts` and nothing here emits JavaScript. Adding tsc emit
  means changing main/exports in nine packages and re-proving that vitest, tsx and
  every entry point still resolve — a real refactor, and not the one that unblocks
  a container. The cost is a transpiler in the runtime image and a slower cold
  start. Before production this becomes a build stage plus a runtime with neither
  tsx nor sources.
- **`node:22-slim`, not distroless.** §14 says distroless where possible; tsx
  wants a real libc. That becomes easy in the same change as the above.

**`NODE_ENV=production` is baked into the image on purpose.** An unconfigured
deployment then refuses to start rather than serving children through the stub
router — confirmed in-container, it exits with the `ANTHROPIC_API_KEY` refusal.
The compose dev profile opts out of that in the open, where you can see it.

**The API binds loopback by default and the Dockerfile sets `HOST=0.0.0.0`.**
The reverse default would silently publish a developer's API — with its database
and, if they exported one, their provider key — to every device on the wifi.

## Before you alter a table

Four invariants are enforced here rather than in application code, because "we'll
remember" is not a control an auditor accepts:

1. `flag` has **no free-text column** — only an FK to vetted phrasing
2. `memory_category` is an enum of exactly the six allowlisted values
3. `CHECK (band <> 'thinker' OR body_enc IS NULL)` — a teen's message body is unstorable
4. `audit_event` triggers raise on UPDATE and DELETE

Removing one of these is a Guardian Council decision, not a migration.

## Verification — one lane

```bash
pnpm test        # starts postgres on :55432 itself, then runs the suite
pnpm db:down     # when you want the container gone
```

There used to be two lanes: a fast default on PGlite (Postgres compiled to WASM,
in-process, no container) and a strict `pnpm test:pg` against a real server. The
fast one was removed on 2026-08-25. It could not do these, and each one is a real
bug it hid at some point:

| | PGlite | Real server |
|---|---|---|
| Constraints, triggers, RLS, plpgsql | ✅ genuine | ✅ genuine |
| pgvector — `CREATE EXTENSION`, `vector(1024)`, HNSW | ❌ shimmed out | ✅ executed |
| Connection pooling, `SET ROLE` per connection | ❌ single connection | ✅ |
| Named schemas (`GRANT USAGE ON SCHEMA`) | ❌ always `public` | ✅ |

It was not even buying speed: 207 DB-backed tests took 48.4s on PGlite against
38.3s on the container, because WASM overhead cost more than Docker does.

The last two rows are not hypothetical. Running the strict lane found that the schema
never granted `USAGE ON SCHEMA` — invisible in `public`, which grants it to PUBLIC by
default, and fatal in any other schema. It also found an RLS test that silently ran as
superuser because `SET ROLE` is per-connection and the pool handed out a different one.

Each fixture on a real server gets its own throwaway schema, so test files run in
parallel against one database.
