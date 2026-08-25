# Runbook — changing which model serves children

`route()` is the single place a vendor is chosen (architecture §12.3). This is
how to change it, and what the system will refuse to let you do.

## The console

`/ops` on the API, if the deployment has operators configured:

```
CHITTU_OPS_TOKENS="arun@tulifo.ai=<32+ chars>,priya@tulifo.ai=<32+ chars>"
```

**With none configured the routes do not exist** — 404, not 403. A login form on
a deployment that never meant to have a console is pure attack surface.

The console shows effective routing (with a preview for one band and country),
the overrides in place, a form to change one, and the history. It ships **no
JavaScript**: forms post, the server redirects.

`changed_by` comes from the **token's name**, not from a form field — a
`changed_by` in the body is ignored, and a test posts one to prove it. That is
stricter than the CLI below, where `who` is an argument you type.

### What the token is, and is not

A shared bearer token is not an account. Rotating one is a redeploy, a leaked
one is valid until then, and there is no per-request revocation. It is
proportionate for a team of two or three and **not** proportionate for twenty —
replace it with real SSO before that is true.

What it cannot do either way: introduce a model (the compiled catalogue decides),
reach an uncleared vendor (`provider_clearance` still applies per child), or
make an unexplained change (`reason` is a CHECK constraint). The worst an
attacker with a token achieves is selecting the wrong *reviewed* model, visibly,
in an append-only log with a name on it.

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

### Scoping it to a country or a band

```bash
# every child in the UK
… set sandbox anthropic:claude-opus-5 you@tulifo.ai "UK residency review pending" --country GB

# teenagers in the UK specifically
… set sandbox anthropic:claude-sonnet-5 you@tulifo.ai "teens need more headroom" --country GB --band thinker

# teenagers everywhere
… set classifier anthropic:claude-sonnet-5 you@tulifo.ai "escalating after a red-team miss" --band thinker
```

Most specific wins:

```
country + band   >   country   >   band   >   unscoped   >   compiled default
```

**Country outranks band.** Country is where a turn may lawfully be processed;
band is a judgement about what suits a nine-year-old. When they disagree, the
legal constraint is not the one to lose.

`show` takes the same flags and answers for one child:

```bash
… show --country GB --band thinker
```

### Clearance follows the child, not the deployment

`route()` checks `provider_clearance` for **that child's country**. A vendor
cleared for India and not the UK now serves Indian children and is refused for
British ones — previously it was unusable for both, because the router did not
know the country and had to require clearance everywhere.

A call with no context still gets the old conservative intersection. That is not
a leftover: a route with no country cannot be checked against one.

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
