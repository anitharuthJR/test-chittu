# Model plan — which model answers what, and what we may keep

**Date:** 2026-08-25 · **Status:** plan, nothing built from it yet
**Reads with:** `chittu-architecture.md` §11 (training data), §12 (routing),
`docs/research/kids_ai_models.html` (the 27-entry landscape),
`docs/runbooks/routing.md` (how routing is operated today)

This answers two requests together, because they collide:

1. *"Implement most of the AI models from the landscape."*
2. *"Answers from the model should be saved in the database so we can use the
   data for training."*

The second one has been asked before. §11 opens by quoting it, and the schema
already implements the answer. What is missing is code.

---

## 1. What already exists

Audited 2026-08-25 against `main`.

| Piece | State |
|---|---|
| `route(category, ctx)` — one choke point | **built**, keyed on category + band + country |
| Config layer: `provider_cell` (db) > `CHITTU_CELL_*` (env) > compiled | **built**, ops console + CLI, append-only history |
| Per-child clearance via `provider_clearance` | **built** |
| Compiled `MODEL_CATALOGUE` (config selects, never injects) | **built** — 1 provider, 3 models |
| `anthropic` adapter, returns `tokensIn`/`tokensOut` | **built** |
| `metering` table (provider, model, tokens, latency, cost, pseudonym) | **built** — phase 1, PR #42 |
| `signal_counter` / `signal_contributor` (k≥25, shape NULL below the floor) | **built** — phase 2 |
| `training_signal` (shapes, k≥25, human review) | schema only — written by `signalRepo.promote`, whose caller is phase 4 |
| `training_example` (four-eyes, leak-proof fingerprint) | schema only — **0 writers** |
| `dataset_export`, `training_run` | schema only — **0 writers** |
| `learning_insight` | schema only — **0 writers** |
| The **abstractor** that produces `shape` (§11.3) | **built** — `@chittu/safety-kernel/abstractor.ts` |
| `corpus_entry` / `corpus_chunk` + pgvector (RAG) | schema only — **0 writers** |
| `vision` / `embedding` cells | declared and catalogued, **nothing routes to them** |
| `chittu-local` (qwen3-4b LoRA) | trains locally; **not deployable**, and see §5 |

**The one-line summary as of 2026-08-25: routing and capture are done; nothing
has been triaged.** Phases 1 and 2 are built. What is missing now is a human
surface (phase 4) and a second provider (phase 3).

---

## 2. The collision, and the line that actually matters

> "Answers from the model should be saved so we can use the data for training."

Part of that is already designed and permitted. Part of it is forbidden by a
promise made to the public, and the schema refuses it by construction:

```sql
CREATE TYPE training_origin AS ENUM (
  'AUTHORED','SYNTHETIC','RED_TEAM','DISTILLED','STAFF'
  -- NOTE: there is no CHILD_TURN value, and adding one is a Council decision,
  -- not a migration.
);
```

### The distinction to hold on to

**Whose turn produced the model's answer?**

| Source of the prompt | May the prompt+completion be stored for training? |
|---|---|
| A **live child's turn** | **No.** Not the child's words, and not the model's reply either — a reply is conditioned on the turn and can carry it. |
| A **synthetic prompt** we authored | Yes — `origin = SYNTHETIC` or `DISTILLED`, human-reviewed. |
| A **consenting adult staff member** | Yes — `origin = STAFF`. |
| A **red-team corpus** prompt | Yes — `origin = RED_TEAM`. |

So "save the model's answers for training" is achievable — **for prompts that did
not come from a child.** That is not a technicality; it is the whole design, and
§11.2 explains why it loses almost nothing:

> what makes production data worth having is not the child's words. It is knowing
> which shapes of input the pipeline handles badly.

And the argument that is not about policy at all (§11.1): **a trained model
cannot forget.** Requirements §9.2 says revocation must propagate. If a child's
turns are in the weights and that family revokes, you owe a retrain, per
revocation, forever. That is an obligation the architecture cannot discharge.

### What we therefore capture from production

The **shape**, never the sentence:

```
child types:  "my labrador Rusty died and i feel empty inside"
stored:       "my <PET> died and i feel <EMOTION>"       (k ≥ 25 sessions)
```

Anything distinctive is destroyed by construction — every token outside a closed
~2,000-word vocabulary becomes `<OOV>` — and a shape is not readable until 25
distinct sessions have produced it. The database enforces it too:
`CONSTRAINT shape_is_abstracted` rejects capitals and punctuation, so raw prose
cannot reach the column through any code path.

---

## 3. The build, in order

Ordered cheapest-and-safest first, with each phase de-risking the next. No phase
depends on a phase after it.

### Phase 1 — Metering — **DONE** (PR #42)

Write the `metering` row the adapter already has the data for: provider, model,
prompt version, tokens in/out, latency, cost, against `session_pseudonym`.

*Why first:* zero doctrine risk (no content, ever), and **you cannot reason
about routing without it.** Every question in phase 3 — is Gemini cheaper, is
haiku fast enough, what does a Thinker turn cost — is unanswerable today.
`chittu-admin.html`'s cost model is currently simulated (`mkSession()`) and
predates v3.3's zero-token paths.

Ship with: a cost table per (provider, model) in code, a `pnpm verify` lane
asserting a maths turn and a crisis turn write **zero** metering rows, because
they make zero model calls.

### Phase 2 — The abstractor + signal capture — **DONE**

Build the pure function §11.3 specifies, in `safety-kernel`, unit-tested like any
other guard:

- names/places/pets → `<NAME>` `<PLACE>` `<PET>`
- any digit run → `<NUM>`
- emotion words from a closed vocabulary → `<EMOTION>`
- **everything outside a ~2k common-word vocabulary → `<OOV>`**

Then a counter table keyed by `shape_hash`, and promotion into `training_signal`
only when `k_sessions >= 25`.

*The tests that matter here are the negative ones.* A corpus of real-looking
child sentences, asserting that no output contains a name, a number, a rare word,
or anything reconstructable. Mutation-test it: remove the OOV rule and the tests
must go red.

*Gate:* this phase does not ship until an independent reviewer tries to
reconstruct a child sentence from a shape and fails.

**What shipped, and the two places it differs from the sketch above.**

- The abstractor is `packages/safety-kernel/src/abstractor.ts`, pure and driven
  by `vocabulary.ts` (~1,700 authored lemmas, inflected by rule). The gate is
  executable: `apps/api/src/signals.test.ts` drives twenty-five sessions of a
  sentence carrying a breed, a pet name, a small town, a rare diagnosis and an
  age, then greps every plaintext column of every table for any of it. A
  positive control proves the sweep can find things, because an all-clear from
  an instrument looking in the wrong place is this repo's most-repeated failure.
- **The runtime does not write `training_signal`, and could not.** The schema
  grants `chittu_app` nothing on the training corpus and calls that absence the
  control. So capture stops at `signal_counter`, and `signalRepo.promote()` —
  which requires a `failure_class` — is for an operator. Its caller is phase 4.
- **`failure_class` is NULL for most captures, on purpose.** The runtime fills
  it in for the two things it can name without deciding what SHOULD have
  happened: a classifier it could not parse, and an output filter that fired.
  For a sandbox escalation it records the layer and the token and leaves the
  judgement to a human. A runtime guessing at OVER_REFUSAL would fill the triage
  queue with confident fiction.

**One thing found on the way, worth knowing about.** `training_signal`'s
`shape_is_abstracted` CHECK was `^[a-z0-9 <>_?'-]+$` — which accepted
`9876543210`, because `0-9` is in that class, and rejected `my <PET> died…`,
because `A-Z` is not. The column whose comment calls it the thing that stops raw
prose reaching it would have taken a ten-digit mobile number and refused its own
documented example. Neither was visible for as long as the table had no writers.
It is now a whitelist of lowercase words and exactly six placeholders.

### Phase 3 — A second provider — **BLOCKED on the vendor's own terms**

`MODEL_CATALOGUE` has one provider. Until it has two, the claim that routing is
provider-agnostic is untested.

~~**Take Google Gemini first** (landscape #1).~~ **This is wrong, and the reason
is the one this plan applied to OpenAI and did not apply to Google.**

Read on 2026-08-25, verbatim, from <https://ai.google.dev/gemini-api/terms>:

> "You must be 18 years of age or older to use the APIs."

> "You also will not use the Services as part of a website, application, or
> other service … that is directed towards or is likely to be accessed by
> individuals under the age of 18."

Chittu is a service directed towards individuals under 18. §3 below rules OpenAI
out because "OpenAI's own position is that its models are not for under-13s";
Google's published terms say something stronger and broader, and this plan
recommended them anyway. **The pedagogy evidence was checked and the contract
was not.**

Three further facts from the same source, for whoever picks this up:

- **Unpaid tier**: "human reviewers may read, annotate, and process your API
  input and output", and submitted content trains Google's models. Disqualifying
  on its own.
- **Paid tier**: "Google doesn't use your prompts … or responses to improve our
  products", with logging "for a limited period" for abuse detection. Discussable.
- `generateContent` is now **legacy**. Its replacement, the Interactions API,
  "stores all Interaction objects (`store=true`)" by default and retains them
  **55 days** on the paid tier (<https://ai.google.dev/gemini-api/docs/interactions>).
  Requirements §9.2 says revocation must propagate, and W5 promises erasure by
  crypto-shred — which reaches our database and not Google's.

Also worth correcting: **there is no callable `learnlm-*` model id.** LearnLM was
folded into the Gemini line, so "route homework to LearnLM" names a capability,
not a model, and `MODEL_CATALOGUE` could never have held it.

**What was done instead**, because it was the part of phase 3 that was neither
blocked nor speculative: the survey that produced the finding above also turned
up three defects live in `main`, all of which a second provider would have made
dangerous. They are fixed, and stripping plus the emptiness check moved into
`callAdapter` so that **no adapter can forget them** — which is the actual
substance of "routing is provider-agnostic". See `PORT-REVIEW.md`.

**What must happen before phase 3 resumes** is decision 5 in §5 below.

Work: a `gemini` adapter implementing `ProviderAdapter` (3 members), an entry in
`MODEL_CATALOGUE`, a `provider_clearance` row per market **after Seat 10 review**,
and the same control-token stripping the Anthropic adapter does.

*Explicitly not OpenAI first.* Landscape #19 is marked `✗` for COPPA and
OpenAI's own position is that its models are not for under-13s. Routing Explorer
or Builder turns there earns us the finding PIRG wrote about Curio. If OpenAI is
wanted, scope it to Thinker only, and make that a Council decision, not a cell.

### Phase 4 — Human review surface (≈3 days)

Signals are worthless until someone triages them. The ops console exists now and
is the place to put it:

`/ops/signals` — shape, count, observed vs expected token, and one action:
*author examples for this*. Writes `training_example` with
`origin = AUTHORED`, `state = PENDING_HUMAN_REVIEW`, and the four-eyes
constraint already blocks the author from approving their own row.

### Phase 5 — Distillation lane (≈3 days)

**This is the phase that delivers the original request.**

Run synthetic and red-team prompts through the *best available* model, store
prompt + completion as `origin = DISTILLED`, human-review, export, train.

Prior art exists: `llm-kit/distill.py`, and `evals/DISTILLATION-PILOT.md`
records why the local 8B could not be the teacher (25% yield). With a real API
key and the router in front, the teacher is Sonnet or Gemini — which is what
`chittu-local-llm-plan.md` §3.1 intended: *"your prototype is the teacher model."*

No child turn is involved at any point, so nothing here needs a Council decision.

### Phase 6 — Self-hosted lane (≈2 weeks, and least certain)

Two candidates from the landscape:

- **Orca-Math 7B** (#3) for Builder maths word problems. The file's claim is that
  a focused 7B beats far larger models in exactly this domain. Note our
  deterministic engine already answers *pure arithmetic* with zero model calls —
  this is for word problems, not sums.
- **`chittu-local`** for the classifier cell, which is what §12.2 always intended.

*Blocked, and honestly:* the Tamil round showed the six-row eval slice has no
measurement power (three seeds, same corpus, gave 0/2, 1/2 and 2/2 on the same
controls). **A self-hosted model cannot be promoted on an eval that cannot
measure it.** Phase 6 does not start until the eval set is rebuilt — ~25–30
held-out crisis and as many near-miss SAFE rows.

---

## 4. What each landscape entry is worth to us

Of 27 entries, **8 are reachable** and 19 are not, which is worth stating before
anyone plans around them.

| Reachable | How | Where it would sit |
|---|---|---|
| LearnLM / Gemini 2.5 | API | `sandbox`, `curriculum`, `vision` |
| GPT-5 family | API | `thinker` only, if at all — see phase 3 |
| Merlyn Origin | open weights | `curriculum`, with `corpus_chunk` RAG |
| Orca-Math 7B | open weights | `homework` (word problems) |
| EduChat | open weights | research comparison only |
| KidLM | open research | abstractor vocabulary reference |
| TinyStories | open (HF) | Explorer story generation, on-device |
| BabyLM | open research | data-efficiency reference |

**Not reachable, and why it matters:** six entries (HeyOtto, PinwheelGPT,
LittleLit, Khanmigo, HolaNolis, ChatGPT Study Mode) are **competitors** — they
occupy the layer Chittu occupies, wrapped around the same foundation models.
Five are closed in-app products (QANDA, TAL, Squirrel, iFLYTEK, Youdao). Four are
apps, four are toys (one defunct), one is in development.

Two cautions from the file that bear directly on us:

- **Moxie (#25) died with its company**, orphaning children's "friends" overnight.
  That is an argument *for* the self-hosted lane, not against it.
- **FoloToy's Kumma was pulled** after the PIRG report for shipping an
  adult-grade LLM to under-13s. That is the specific risk in phase 3's ordering.

---

## 5. Decisions this plan needs from a human

1. **Does phase 5's distillation lane need Council sign-off?** My reading is no —
   no child turn is involved — but it is the first time model output is stored
   for training, and I would rather ask.
2. **Is OpenAI in scope at all?** If yes, Thinker-only, and it is a Council
   decision because of #19's COPPA position.
3. **Who reviews signals?** Phase 4 builds the surface; the four-eyes constraint
   means it needs at least two named people who are not each other.
4. **What is the retention on `metering`?** It holds no content, but it is a
   per-session behavioural record and DPDP bars behavioural monitoring of
   children. Needs a number, not a default. *With two vendors it also becomes
   the only per-turn record of which vendor received a given child's turn —
   `audit_event` seals the trace label and names no provider — so it is the
   cross-border-transfer evidence a DPIA would ask for.*

5. **Which second provider, now that Google is ruled out by its own terms?**
   Phase 3 cannot resume without an answer. The options, none of which an
   engineer should pick alone:
   - **Vertex AI** (same models, Google Cloud terms rather than the Gemini API
     Additional Terms, service-account auth, different endpoint). Needs its own
     terms review — the age clause may not carry over, and that is precisely the
     thing to check rather than assume.
   - **A self-hosted open model** — Merlyn Origin Suite (answers only from
     school-selected curriculum) or Orca-Math 7B for word problems.
     No vendor terms at all, which removes this whole class of problem, and it
     is where §12.2 says the classifier belongs anyway. Slower.
   - **A second Anthropic model as the "second provider"** — honest about what it
     proves (the cell layer) and what it does not (that the port is
     vendor-agnostic). Cheap; largely theatre.
   - **Stop at one provider** and spend phase 3 on phase 4 instead, since the
     signals from phase 2 have no human surface yet.

---

## 6. What this plan deliberately does not do

- **It does not add `CHILD_TURN` to `training_origin`.** That is the request as
  originally phrased and the schema refuses it on purpose.
- **It does not route on cost or latency.** Phase 1 makes that *possible*; whether
  a cheaper model should serve some children and not others is a product and
  fairness question (Seat 44), not a routing feature.
- **It does not wire `vision`.** The cell exists; the consent scope exists
  (`ConsentScope` includes `vision`); no product decision has been made about
  what a child may photograph.
