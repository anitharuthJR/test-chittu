# Port review — findings that need a human

The prototype's safety logic was ported to TypeScript by one agent per package,
each reviewed by a second, independent agent whose only job was to find behaviour
changes. This is what that found. Items are ordered by what a reviewer should look
at first, not by when they were found.

Everything here is **already ported faithfully**. Nothing in this list has been
"fixed" unilaterally, because CLAUDE.md makes the L1 lexicon and the pipeline
order non-negotiable invariants and requires explicit sign-off to change safety
logic.

---

## 1. FIXED — the Kindness Guard was missing from the port

**Severity: high. Already corrected in this branch.**

The prototype's L1 fast path runs **six** guards, not five. The sixth is at
`chittu-v3.html:1058`:

```js
if(PROFANITY.test(text)){S.spineCount++;addChittu(PROFANITY_REPLY,'KINDNESS GUARD · scripted');return}
```

It was missed because `PROFANITY` is declared *outside* the `LEX` object — a port
that reads `LEX` sees five patterns where the dispatch has six. My `GuardKind`
contract had the same five, so the type system agreed with the mistake.

**Consequence had it shipped:** a child's profane turn would be forwarded to a
model provider, where the prototype answered it with a script and spent no tokens
at all. `spineCount` would not increment, and the scripted kindness reply would be
replaced by whatever the model said.

Restored, with `PROFANITY_REPLY` verified byte-identical to the prototype's string.
`L1_PATTERNS` now covers every `GuardKind`, and a test fails if a kind ever lacks a
pattern — so this specific class of omission cannot recur silently.

## 2. FIXED — `seal.append` could silently seal the wrong field

**Severity: high. Already corrected in this branch.**

The prototype is `auditAdd(role, text, layer)`; the port was
`append(role, layer, text)`. Both arguments are strings, so a transposed call
**typechecks, runs, and still verifies OK** — while the child's words land in
`layer`, which is *not* part of the hashed payload, and the layer name gets sealed
in their place. The chain would then evidence nothing that was actually said.

`append` now takes a named `SealEvent` object, which makes the mistake
unrepresentable rather than merely unlikely.

---

## 3. FIXED (signed off 2026-08-24) — fail-open in the Tanglish crisis pattern

`LEX.crisis` carried `saaga (venum|num)` — one literal space — so the spellings a
child actually types did not fire. It read like `saaganum` had been split by
mistake.

Investigating before changing it showed the gap was wider than the space. சாக is
romanised several ways, and treating one of them as the word meant the rest failed
open too. **Six of eleven plausible spellings missed**, including every one-word
form:

| before | after |
|---|---|
| `saaganum` ❌ | ✅ |
| `enakku saaganum` ❌ | ✅ |
| `naan saaganum` ❌ | ✅ |
| `saaganumnu thonuthu` ❌ | ✅ |
| `saganum` ❌ | ✅ |
| `sakanum` ❌ | ✅ |
| `saaka venum` ❌ | ✅ |
| `saaga venum` ✅ | ✅ |
| `saaga num` ✅ | ✅ |

Now `sa{1,2}[kg]a?\s*(venum|num)`, applied to BOTH `prototype/chittu-v3.html` and
`packages/safety-kernel/src/lexicon.ts`, verified byte-identical between them.

**Deliberately no trailing `\b`.** It would look tidier and would break
`saaganumnu` — a completely ordinary form — for the sake of contrived words like
"saakanumber". Missing a child is the worse error.

The stem is short, so over-firing was the thing to check rather than assume. 13
probes are locked as regression tests: *saga*, *the saga of the rings*, *sakura*,
*Sagan*, *magnum opus*, *saxophone number*, *a number line*, *saag paneer*,
*Nagano*, *vacuum*, *sagacious*. None fire.

The tests that previously pinned the BROKEN behaviour are gone, replaced by ones
asserting the fix — which is exactly why they were written that way: a fix could
not land unnoticed.

### Still open at the model layer

This closes the L1 gap. `llm-kit/attack_prompts.txt` carries one Tanglish crisis
prompt (`vaazhkai venam nu thonuthu`) and no `saaganum` form, so the classifier and
sandbox are still untested on it. `chittu-status.md` §7 records a Tamil crisis
phrase going unrecognised by the model, and GAP-03 calls safety "monolingual in
practice" — L1 is now less monolingual than L2, L5 and L6 are.

## 4. NEEDS A DECISION — the seal digest is truncated to 64 bits

`sha` returns 16 hex characters, so collision resistance is roughly 2^32 by the
birthday bound, not 2^128. The prototype does this and the port preserves it.

Unlike the prototype, **this backend has no existing seals to invalidate** — the
cost of widening the digest is zero right now and rises with every sealed turn. If
the chain is ever offered as legal-grade tamper evidence, 64 bits will not carry it.

## 5. NEEDS A DECISION — `layer`, `prev` and `t` are outside the hash

The payload is `role + '|' + text`. `verify()` recomputes hashes but never checks
`prev`, so a record whose `prev` field alone is edited still verifies as OK. The
`layer` shown in the parent ledger can likewise be altered without breaking
verification.

Related: the `'|'` delimiter is unescaped, so `role='child', text='a|b'` hashes
identically to any other split of `child|a|b` — the role is not cryptographically
bound to the hash.

Ported faithfully and locked by tests. Worth deciding before the ledger is used as
evidence for anything.

## 6. NOTED — `route()`'s asymmetric side effects are not yet ported

`route()` maps each guard kind to a *different* set of effects, and the asymmetry is
deliberate:

| kind | spineCount | parent flag | topic |
|---|---|---|---|
| CRISIS | ✓ | `CRISIS` | `⚑ wellbeing` |
| PII | ✓ | **none** | `privacy nudge` |
| UNSAFE | ✓ | `UNSAFE` | **none** |
| IDENTITY | ✓ | **none** | `identity/feelings` |
| SECRET | ✓ | `SECRET-KEEPING` | **none** |

`scan()` returns the guard kind and nothing else, which is correct for a pure
function — but the mapping above belongs in the pipeline orchestrator and is not
written yet. Recorded here so it is ported from this table rather than guessed.

## 7. NOTED — prototype over-triggers, ported as-is

`unsafe` is unanchored, so substrings inside ordinary words trip it: *"i have begun
my homework"* → unsafe (`gun` in `begun`), *"tell me about seaweed"* → unsafe
(`weed`), *"the ball hit me"* → crisis (bare `hit me`).

These fail **closed**, and `chittu-status.md` §8.3 records them as a deliberate
accepted trade-off with the classifier as the intended rescue layer. Note that the
rescue cannot currently happen — L1 short-circuits before L2 runs. See
`chittu-architecture.md` §10.4.

Also minor: `\bshit\b` needs a word boundary, so *"bullshit"* is not caught by the
Kindness Guard.

---

## What the review process was worth

Six ports, six independent adversarial reviews. The reviewers found two defects that
would have shipped (§1, §2) and surfaced four decisions that were invisible before
(§3–§6). One reviewer finding was itself wrong — it claimed the spines tests did not
execute, when they were merely failing to resolve a workspace link that had not been
installed yet. Agent findings are evidence, not verdicts.

---

## 8. FIXED — the orchestrator sealed only half the conversation

**Found by a smoke test, not by the unit tests. Already corrected.**

`GET /seal` reported **2 records after 2 turns**. The chain was recording each
child's turn and none of Chittu's replies, because sealing lived at the end of the
sandbox path rather than in the reply helper.

In the prototype, `auditAdd('chittu', flat, layer)` sits inside `addChittu`, which
all 26 reply paths call — scripted guards included. So a crisis turn would have
left the ledger holding the child's words and **no record of what the system said
back**, which is the moment a ledger most needs to be complete.

Sealing moved into `reply()`, so every path seals both records. Now covered by a
regression test over all seven reply paths, plus one asserting the chain records
what the child was *shown* rather than the raw model text — a blocked L6 reply must
not appear in the ledger as though it had been delivered.

**Worth noting how it was caught.** 554 unit tests were green. `curl` found it in
one request, because the unit tests asserted the chain *verified* and never
asserted how much was *in* it. A chain with half the conversation missing verifies
perfectly.

---

## 9. The consent engine — deliberate deviations and what is still stubbed

### FIXED — the PIN hash is not the prototype's

`chittu-v3.html:818` does `sha('PIN|' + pin)`: unsalted SHA-256, truncated to 64
bits, in the browser. Ported verbatim onto a server that would be a real defect —
a 4-digit PIN has 10,000 possibilities, so an unsalted digest is reversible by
enumeration in microseconds.

"Port semantics, do not rewrite" governs the safety *behaviour* — the guards, the
order, the scripted copy. It is not a licence to move a browser demo's crypto onto
a server. The KDF is now salted scrypt.

**And an honest limit, recorded in the code:** no KDF rescues a 4-digit PIN if the
hash leaks. The keyspace is the problem. The controls that actually matter are
never exposing the hash, rate-limiting, and the five-attempt lockout.

### FIXED — scrypt's cost parameters were silently unusable

`N=32768, r=8` needs ~32 MiB, and Node's default `maxmem` is *also* 32 MiB, so
every call failed with "memory limit exceeded". Caught by the test asserting the
stored parameters, not by review. Left implicit, the cost parameters would have
looked configured and been decorative.

Related: `promisify(scrypt)` resolves to the 3-argument overload and **silently
drops the options object** — so N/r/p would have fallen back to Node's defaults
even once maxmem was fixed. Wrapped by hand instead.

### DELIBERATE — the weak-PIN list is wider than the prototype's

The prototype rejects six literals and accepts `4321`, `9999`, `2222`. This is the
one direction it is safe to strengthen without sign-off: **rejecting more PINs
cannot fail open.** It can only refuse a parent a PIN they wanted, which surfaces
immediately as a message — unlike a guard that silently stops firing.

### STILL STUBBED — four of six adapters

`card_micro_charge`, `email_plus`, `gov_id_review`, `consent_manager_token` and
`age_assurance_uk` have a real shape and no implementation. Each **throws with the
reason** rather than succeeding quietly, because a silently-succeeding stub in this
position would mint consent records for verifications that never happened.

`GET /v1/consent/methods` returns `methods` (what a parent can complete today) and
`offers` (everything valid in that country, each with `blockedOn`). The first is for
the client; the second is so ops can see what blocks a market.

Implemented and usable: `dev_stub` (non-production, refused in prod by both the code
and the database) and `signed_form_review`, which works because it is a human ops
process rather than a vendor API — though its document-retention rules need the DPO
before it carries a real family.

### DigiLocker is refused twice

No adapter exists, `selectAdapter` throws, and `CONSTRAINT digilocker_deferred`
refuses the method in the database. Two independent refusals for one deferral, so
no ledger row can claim a verification that no code performed. When the adapter
ships, both come off together.

### A note on mutation coverage

Removing the `assertActiveConsent` call failed only **one** API test, which is
weaker than it looks. Revocation also nulls the bearer token, so two independent
mechanisms refuse a revoked consent and an API-level test cannot tell which fired.
The status path is therefore covered directly by unit tests in `@chittu/consent`.
Worth remembering if either layer is ever simplified away.

---

## 10. Wiring to Postgres — five defects, and how each was found

### FIXED — `chittu_app` had five RLS policies and no table grants

A policy NARROWS access a role already has; it confers none. The application role
could not read or write a single row, and the five carefully-scoped policies were
inert. Invisible because every schema test ran as **superuser**, which bypasses
both grants and RLS. Found by writing a test that does `SET ROLE chittu_app`.

### FIXED — `UNIQUE(hash)` rejected the second child to ask the same first question

Both chains started from a shared `GENESIS`, so two sessions whose first turn was
identical produced the same payload hash from the same previous hash — hence the
same record hash. Two children opening with *"why is the sky blue"* is not an edge
case. Each session now starts from `GENESIS|<sessionId>`, which also means a
record cannot be lifted from one child's chain into another's.

### FIXED — `audit_event.layer` was the wrong type

Typed as the `pipeline_layer` enum, on the assumption that the seal carries a
machine-readable layer. It does not: the prototype seals the human-readable TRACE
LABEL, because that string is what the parent's ledger displays. Now `text`, with
the ordered machine-readable walk stored in `message.trace` instead. One column,
one job.

### FIXED — rate limiting was silently absent from every route

`app.register()` defers plugin loading until `ready()`, so routes declared
synchronously afterwards were registered before the plugin's `onRequest` hook
existed — and the hook never reached them. A flood of `/health` returned 200 six
times out of six with `max: 3`.

This one is worth dwelling on. The architecture doc claims rate limiting protects
the PIN endpoint, and the PIN lockout is what actually defends a 4-digit secret.
`buildServer` is now async so the registration is awaited, and a regression test
floods a route and asserts a 429 — because "we registered the plugin" was never
evidence that anything was limited.

### FIXED — a repository read from the pool inside its caller's transaction

`loadSession` called `consent.byId()`, which used the pool while the caller held a
transaction. On PGlite — one connection — that deadlocks, which is how it was
found. On real Postgres it would NOT have deadlocked; it would have taken a second
connection and quietly read a different snapshot than the one being written.
Repository reads now take a `Db` handle, so "which transaction is this in?" cannot
be fudged.

### NEEDS A DECISION — a teen's words now exist in one place

`message.body_enc` refuses a body for `thinker`, so the classifier's 3-message
rolling window has nowhere to live across requests. Without it the classifier
loses context for exactly the band whose turns most need it.

It is currently in `session.runtime_enc`: encrypted under the child's DEK, session
lifetime rather than 30 days, destroyed by the crypto-shred. But it is still a
teen's words at rest, and the Session 001 ruling says they are not stored.
**Chamber II should decide** whether the trade is right, or whether teen
classification should degrade instead.

### NOTED — what PGlite does not test

PGlite is real Postgres (WASM), so constraints, triggers, RLS and plpgsql are the
genuine article with no container to run. Three things it does not cover:
`CREATE EXTENSION vector`, the `vector(1024)` column and the HNSW index are shimmed
out; there is only one connection, so lock contention and serialization failures
are unexercised; and it is not the RDS binary. A `docker compose` Postgres 16 +
pgvector run of the same suite via `DATABASE_URL` would close all three — the `Db`
port and `bootstrapDb()` already support it.

---

## The client (apps/web)

### FIXED — the consent token is no longer in JavaScript's hands

`finalize` now sets `chittu_consent` as an **httpOnly, SameSite=Strict** cookie
(`Secure` outside dev) and returns only the ledger. The token appears in no
response body, and `document.cookie` is empty in a signed-in browser — verified
in the running app, not only in a test.

The client can no longer answer "am I signed in?" from memory, so it asks
`GET /v1/consent/status`. That turned the routing gate from two states into
three, and the third one is the interesting one: **`unknown` renders neither the
chat nor the consent form.** Showing the chat before the answer arrives would be
the Law 02 failure; showing the seven-step form to a family who already finished
it would be its own bug. An unreachable API resolves to "not signed in", because
a server that cannot be asked has not said yes.

`POST /v1/session` has **no body fallback** — presenting the token in the body is
a 400. Two ways in would have made the safe one optional.

### FIXED — anyone with a consent id could erase a child's account

Found while doing the above, and worse than the thing it was found next to.
`DELETE /v1/consent/:id` authenticated **nothing**: a consent id was sufficient
to erase a family's entire record. The client was keeping one in `localStorage`,
so the child could read it, and so could anything that had ever seen it.

Fixed by making PIN verification issue a second cookie. `POST /v1/parent/pin/verify`
mints `chittu_parent` — an HMAC over `consentId|expiry` under the same
deterministic index key the blind indexes use, so there is no table and no
migration — and the destructive routes require it:

| route | before | now |
|---|---|---|
| `DELETE /v1/consent` | nothing | consent cookie **+ live parent session** |
| `POST /session/:id/crisis/ack` | nothing, dev-only | consent cookie **+ live parent session for that consent** |
| `DELETE /session/:id/memories/:id` | `?by=` believed from the query string | `deleted_by` **derived** from the parent cookie |

Fifteen minutes, and leaving the dashboard calls `POST /v1/parent/signout`, so
walking away does not leave a quarter of an hour of authority on the sofa.

This also closes the §4.5 note that said the crisis unlock "MUST be behind PIN
verification before this ships — that binding is not wired yet". It is wired, so
the route no longer needs its `env !== 'prod'` guard and no longer has one.

**Verified from inside a child's own authenticated browser session:** with a
valid consent cookie, `fetch('/v1/session/…/crisis/ack', {method:'POST'})` and
`fetch('/v1/consent', {method:'DELETE'})` both return 403 `PARENT_REQUIRED`, and
the chat stays locked.

### NOTED — the parent session cannot be revoked before it expires

It is signed, not stored, which is why it needs no table. The cost is that a
minted session stays valid for its fifteen minutes even if the parent signs out
on another device. Erasing the consent makes the id inside it resolve to nothing,
which covers the case that matters; if a revocable parent session is ever wanted,
it needs a row and a migration.

### NOTED — `fingerprint()` lowercases, which is wrong for anything but an index

`packages/db/src/crypto.ts` trims and lowercases before hashing. That is correct
for `parent.email_hash`, and it is why `mintParentSession` does **not** use it —
a signature where `A` and `a` agree is not a signature. `cookies.test.ts` pins
that difference so nobody "simplifies" the two together.

It also means `consent_record.token_hash` is a hash of a *lowercased* base64url
token: about 223 bits of entropy rather than 256. Not a practical weakness, but
surprising enough to write down.

### FIXED — the fonts are self-hosted

Four families, five WOFF2 files, **72.7 KB** on the wire, committed to
`apps/web/src/fonts/` with their OFL 1.1 licences and regenerated by
`scripts/build-fonts.sh`. No request leaves our origin; `fonts.test.ts` fails if
one ever does, and it checks `href`/`src` references rather than string mentions
so the comments explaining the rule do not trip it.

Naive packaging would have been ~136 KB. Three decisions got it to 72.7:

- **Variable faces where they exist**, with the weight axis instanced to the
  range the design uses (Nunito 400–800, Baloo 2 700–800). Worth ~13% on Nunito
  and more on Baloo 2, which needs only a sliver of its range.
- **Character coverage decided per family, not globally.** Nunito and IBM Plex
  Mono render text we do not control — a child's typing, a model's code block —
  so they keep the full Google `latin` range. Trimming those to "characters we
  have seen" would render tofu the first time a child typed something we had not
  anticipated, and it would look like a bug in the child's language.
- **The Tamil face subset to the brand mark.** 38 KB → 1.5 KB.

### FIXED — the Tamil brand mark had no brand font

Found while doing the above. Baloo 2 carries no Tamil, so `சிட்டு` — half the
logotype — fell through to whatever Tamil face the device happened to have: a
different design on every phone, for the one string that is supposed to be
constant. It now uses Baloo Thambi 2, the Tamil sibling of Baloo 2 by the same
foundry, subset to the five codepoints of the brand mark.

Because it is a text-based subset it is only safe while the Tamil in this
product is one logotype. `fonts.test.ts` scans the UI source and fails if Tamil
appears anywhere else, naming the file and telling you to regenerate.

### NOTED — `→` and `↳` come from a system font, deliberately

The trace strip joins pipeline layers with `→` and opens with `↳`. Neither
character exists in **any** subset of Nunito, Baloo 2 or IBM Plex Mono — checked
against the source cmaps, not assumed — so there is nothing to subset in. They
render from a system face.

That is fine for a 9.5px diagnostic strip, and it is recorded rather than left
to be rediscovered. A test asserts the two are still absent everywhere, so if a
font update ever supplies them the suite says so and the fallback can go.

**Worth remembering how this nearly slipped through.** Measuring the glyph's
width in a real browser said it was present: the system fallback was also
monospace, so the advance matched exactly. The proxy measurement agreed with the
wrong answer. Only reading the cmap of the built file settled it — which is why
the build now emits `coverage.json` and the test reads that instead.

### NOTED — ₹ needed its own face

The rupee is in Google's `latin-ext`, not `latin`, so it was falling back
mid-sentence in body copy. This is an India-first product whose maths lessons
talk about money, and a mismatched glyph at 15.5px in prose is far more visible
than one in a 9.5px trace. One codepoint, 1.2 KB, its own `unicode-range`.

### NOTED — a reload loses the conversation, but not the record

`messages` lives in memory. On reload the client opens a **new** session and the
previous exchange is gone from the screen. Nothing is lost from the database —
the transcript and the seal chain are intact — but there is no
`GET /v1/session/:id/messages`, so the client cannot restore what it is entitled
to show. Two consequences worth stating: a child who reloads mid-conversation
starts over, and the seal chain gains a session per reload.

### NOTED — the client duplicates `stripControlTokens` on purpose

`apps/web/src/safety/render-guard.ts` reimplements forty lines that already exist
in `@chittu/safety-kernel`. Importing the kernel instead would bundle
`L1_PATTERNS` — the complete list of what we detect — into a child's browser,
where anyone can read it and design around it. The evasion cost of a published
lexicon is far higher than the drift cost of a duplicate with a pin, so
`render-guard.test.ts` runs both implementations over the kernel's own corpus of
ported defects and fails if they ever disagree.

The duplicate inherits one known hole, pinned as a test: only the literal
`</think>` triggers the slice-to-last-close, so `<reasoning>…</reasoning>`
contents survive as prose. **The kernel has the same hole.** Fix it there; the
client must not diverge unilaterally or the pin becomes the thing that breaks.

### NOTED — four parent panels are absent, not mocked

The dashboard shows transcripts, safety flags, assist flags, the learning queue
and helplines as "not built yet", naming the endpoint each needs. That is
deliberate. A parent dashboard filled with plausible sample data would defeat the
one claim the product actually makes — that a parent can *check*.

### NOTED — Vitest 2.1 and Vite 6 disagree about types

The client builds on Vite 6 (§2.1) while Vitest 2.1 bundles Vite 5's types, and
the two `Plugin` types are structurally incompatible under
`exactOptionalPropertyTypes`. The suite **runs** fine; only
`apps/web/vitest.config.ts` cannot be typechecked, and it is excluded from
`tsconfig.json` with that reason recorded in the file. Upgrading Vitest repo-wide
resolves it and should be done on its own, where a break in the 740-test suite
would be visible rather than blamed on the client.

### FIXED DURING THE PORT — the crisis panel covered the conversation

At the 900px breakpoint the crisis panel and the message log were assigned the
same CSS grid area, so they rendered on top of each other. Every test passed;
the bug was only visible by loading the page and triggering an actual crisis.
Worth recording as a class: **a layout defect on the one screen where legibility
matters most is not reachable by unit tests**, and neither the 62 client tests
nor the 740-test suite would ever have caught it.

### FIXED DURING THE PORT — text-to-speech was a second, unguarded channel

The first draft of `speak()` in `Chat.tsx` read `blocks` straight off the API
response. The renderer drops a leaked escalation token from the screen; a speech
synthesiser reading the raw response would have said it out loud anyway. It now
guards its own input. The general shape — *every* output channel guards, not just
the visible one — should be checked again when the reading coach lands.
