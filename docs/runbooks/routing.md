# Runbook — changing which model serves children

`route()` is the single place a vendor is chosen (architecture §12.3). This is
how to change it, and what the system will refuse to let you do.

## Look before you touch

```bash
pnpm --filter @chittu/api exec tsx src/providers/cli.ts show
pnpm --filter @chittu/api exec tsx src/providers/cli.ts catalogue
```

`show` prints the effective assignment per category and where each came from —
`default`, `env` or `db`. `catalogue` prints every `(provider, model)` pair this
build may route to.

## Change one cell

```bash
pnpm --filter @chittu/api exec tsx src/providers/cli.ts \
  set classifier anthropic:claude-sonnet-5 you@tulifo.ai "haiku missed two red-team prompts, escalating pending review"
```

Then **restart the API**. Cells are read once at boot, deliberately: routing that
changes under a turn in flight is worse than routing that needs a restart.

`changed_by` and `reason` are required by CHECK constraints, not by convention.
The table is append-only, so `history` is the record an incident review reads:

```bash
pnpm --filter @chittu/api exec tsx src/providers/cli.ts history classifier
```

## Precedence

```
provider_cell (db)  >  CHITTU_CELL_<CATEGORY> (env)  >  DEFAULT_CELLS (compiled)
```

DB outranks env because the whole point of the table is changing routing without
a deploy. A deployment that must not be overridable at runtime sets
`CHITTU_ROUTING_DB=off`, which is reported at startup.

## What you will not be allowed to do

| attempt | what happens |
|---|---|
| a model not in `MODEL_CATALOGUE` | refused by the CLI; refused again at startup |
| a provider with no adapter | same |
| set a `promptVersion` | ignored — it is derived from the code that owns the prompt |
| route to an uncleared vendor | `route()` refuses per `provider_clearance` |
| a typo in `CHITTU_CELL_*` | reported, compiled default used; **refuses to start in production** |

Adding a model to the catalogue is a code change in
`apps/api/src/providers/cells.ts`. That is on purpose: a model that serves
children should be reviewed in a diff, not typed into a table at 2am.

## If routing looks wrong

1. `show` — is the cell where you think it is, and from which source?
2. Check the startup log. It prints either `all cells at compiled defaults` or
   `routing overrides IN EFFECT` with each assignment and its origin.
3. Anything rejected is printed as `routing config REJECTED: …` with the value
   quoted. A rejected cell runs the compiled default — it does not run what you
   asked for.
