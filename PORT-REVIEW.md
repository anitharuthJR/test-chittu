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

## 5. NEEDS A DECISION — `layer` and `t` are outside the hash

**Corrected 2026-08-25, and narrowed.** An earlier version of this entry said the
chain does not check `prev`, which is true of the stored FIELD and reads worse
than the reality. `verifyRecords` recomputes from a RUNNING hash seeded at
GENESIS, so the links genuinely are verified. `packages/seal/src/tamper.test.ts`
demonstrates each case rather than asserting it in prose.

**Caught today** — an edited message, a deleted middle record, two records
swapped, and a record appended by someone who does not know the head. The chain
is content- and order-tamper-evident, which is the main thing it claims.

**Not caught** — and this is the decision:

| Field | Consequence |
|---|---|
| `t` | A ledger offered as evidence of WHEN something was said does not currently evidence when it was said. Timestamps can be rewritten freely. |
| `layer` | The parent dashboard renders it. It can be made to say a turn was handled by a layer that never touched it. |
| stored `prev` | Ignored by verification, so it can disagree with the real link. A forensics problem: someone reading an export sees a chain that does not join up and a verifier that says it does. |

The `'|'` delimiter is unescaped, but this is NOT exploitable as first written:
`SealRole` is a four-value enum, so `child|a|b` has exactly one parse consistent
with the type. Noting it as closed rather than leaving it as a live concern.

Ported faithfully and locked by tests. Worth deciding before the ledger is used as
evidence for anything — and note that §4's 64-bit truncation is the more
serious of the two, since it is an attack at ~2^32 work rather than an
unauthenticated field.

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

### FIXED — a reload was an escape from the crisis lock

The reported symptom was cosmetic: a reload lost the conversation from the
screen. The cause was not. `crisis_lock` lives on the session, and the client
opened a **new** session on every page load — so a child who hit a crisis lock
could press F5 and carry on. New session, `crisisLock: false`, next turn
straight to a model.

Doctrine says the only exit from a crisis lock is a parent's acknowledgement
(§4.5). A page reload was an exit. Confirmed by probe before fixing:

```
after crisis turn, crisisLock = true
new session id differs        = true
new session crisisLock        = false
reply after reload            = [{"kind":"text","text":"I'm still learning..."}]
```

`POST /v1/session` now RESUMES the child's live session. The policy:

- a crisis-locked session is resumed **regardless of age**, so the lock can be
  neither reloaded nor waited out;
- a recent session is resumed, so a reload keeps the conversation and the
  classifier's rolling window;
- a stale one is closed `ended_reason='timeout'` and a new one begins, because
  "session-only conversation memory; forgetting is a feature" (§7).

**The window is 12 hours, signed off by the product owner on 2026-08-24.** It is
`SESSION_STALE_AFTER_HOURS` rather than an inline literal because it is a
product judgement, not a technical constant: it draws the line between "I put
the tablet down and picked it back up" and "it is the next day, this is a fresh
chat". A test pins the value so moving it is a decision rather than a passing
edit, and a second test checks the boundary against the constant so it keeps
testing the right thing wherever the line is moved to.

The window does **not** bound a crisis lock, and a test says so at 100× the
window. It decides when a conversation restarts, never when a lock lifts.

The response carries `resumed` and `crisisLock`, and the client re-applies the
lock from the server rather than from a local signal it could not have set. It
also stops the seal chain gaining a session per reload.

`GET /v1/session/:id/messages` repaints the conversation. Only the text is
restored, not the cards and chips: what is stored is the flattened reply, and
blocks cannot be re-derived from it. That is a fair trade against losing the
conversation, and nothing is invented that was not said.

**A teen cannot be repainted at all** — their words were never written down.
The route says so (`restorable: false`) and the client shows the sentence rather
than an empty screen, which would read as "we lost your chat". That is the cost
of the carve-out, stated out loud.

### FIXED — chips were being stored as though Chittu had said them

Found while looking at a repainted screen. The stored reply flattened chip
labels into the prose, producing *"I'm still learning that one! Tell me more
Something else"* — in a parent's transcript, and then on the child's screen once
a reload repainted from the same text.

Chips are suggested next taps, not utterance. They are excluded from the stored
body now, which improves the parent transcript as much as the repaint. They are
still shown to the child in the live turn; a test asserts both halves.

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

### FIXED — the four absent parent panels are built

`GET /v1/parent/dashboard`, `GET /v1/parent/sessions/:id/transcript` and
`GET /v1/helplines/:country` now back all seven W4 panels with real data. Every
one is behind the parent session cookie except the helplines, which are
deliberately open: a child in trouble must not need an adult to unlock a
helpline first.

Two panels **say something** rather than showing an empty box, which is the
"don't mock it" principle pointed the other way. The safety panel states that it
carries a category and never a quote; the learning panel states that there is no
per-child list because `learning_insight` has no foreign key to a child. An
empty box reads as "nothing has happened yet" in both cases, and in the second
that would be actively misleading.

### FIXED — the crisis panel was invisible to a parent on their own phone

Found by loading the dashboard rather than by any test. The panel read
`crisisLock` from the in-memory signal that only a turn in *this browser tab*
sets, and the unlock button targeted `session.value` — null whenever a parent
opens the dashboard on their own device.

So the one case the panel exists for — a parent checking on a paused chat from
somewhere other than the child's tablet — showed nothing, and had it shown
something the button would have done nothing. Both now come from the dashboard
payload, which is the server's answer. `App.test.tsx` builds exactly that
situation: `session.value` null, server reporting a locked session, and asserts
`ackCrisis` is called with the id the server named.

### NOTED — the teen carve-out is two controls, and only one was tested

`teen_bodies_are_never_stored` is a CHECK on `message.band`; the transcript route
decides from `session.band`. Those can disagree — a band change mid-session, or a
bug writing the wrong band — and in that gap the database has nothing to say, so
the route re-applies the rule itself.

Deleting that re-application changed **nothing observable**, because the CHECK
already nulls teen bodies in every case the tests produced. A guard whose removal
is silent is not a guard, so there is now a test that inserts the row the
database permits and the route must still withhold: a `builder` message, with a
real encrypted body, inside a `thinker`'s session.

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

---

## The provider router

### FIXED — the router is real

`apps/api/src/providers/` now holds an Anthropic adapter and a router that
implements §12's cell assignments. `main.ts` picks it when `ANTHROPIC_API_KEY`
is set and falls back to the stub — loudly — when it is not.

The prompts came with it. The classifier prompt and its parser are in
`@chittu/safety-kernel` (L2 is a safety layer, and it inherits that package's
100%-coverage bar); the fifteen-rule sandbox prompt and the 23 curriculum boards
are in `@chittu/pedagogy`. Both were **ported, not rewritten** — a test asserts
each hard rule still appears, because a prompt clause deleted in a tidy-up looks
like nothing at all in a diff.

### NOTED — the one thing the tests cannot prove

There is no `ANTHROPIC_API_KEY` in this environment and CI must never need one,
so the suite drives the adapter over real HTTP against a local Node server
standing in for the vendor. That exercises the request body, the headers, the
timeout, the retry policy, the error mapping and the control-token strip — but
it **does not prove Anthropic accepts our request shape**. The first real call
is still the first real call. Everything up to the wire is verified; the wire is
not.

The stand-in was also driven end to end: consent → chat → a rendered reply, with
the fake vendor logging `CLASSIFY model=claude-haiku-4-5 system=2010b` and
`SANDBOX model=claude-sonnet-5 system=5206b`, and with the no-model paths
confirmed to make **zero** vendor calls.

### FIXED (2026-08-25) — three defects found while surveying for a second provider

None of these are about Gemini. All three were live in `main`, and all three
were invisible because the tests around them used conventions the production
caller does not.

**1. The child's turn was sent to every vendor cell TWICE.** `runTurn` appends
the child's turn to `history` before any port is called, and both router paths
appended `input.text` again. The sandbox body was `[…, user, user]` with the
last two identical, **from turn one onward** — `runTurn` appends before the
first port call, so there was never a turn where the two conventions agreed. It
cost tokens against Anthropic. Whether another vendor would reject two adjacent
`user` messages outright is *not* established here and is not claimed; it is one
of the things a second adapter would find out.

`scripts/smoke-dist.mjs` could not have caught it either way: both turns it
drives (`what is 7 times 8`, `i want to die`) are zero-model paths and never
reach the router.

The classifier damage is worse and is not cosmetic. The window is three of the
child's turns, and the point of the window is patterns *across* turns —
`CLASSIFIER_SYSTEM` says so: "escalating secrecy, boundary-testing, repeated
distress". Sending the current turn twice pushed a real turn of context out of a
three-turn window:

```
[msg 1] second question     <- 'first question' has fallen out
[msg 2] third question
[msg 3] third question      <- the same turn again
```

And it did something worse than that. On the **first turn a child ever sends**,
with no history at all, the window already read as a repetition:

```
turn 1, before:  [msg 1] i feel awful | [msg 2] i feel awful
turn 1, after:   [msg 1] i feel awful
```

Every turn looked like a repeat to the one layer that escalates on repeats. Two
tests now drive the real pipeline through the real router with a child saying
the same sentence two and three times, and assert the window shows exactly what
was said — because a conditional append is only correct if genuine repetition
still reaches the classifier.

The prototype pushes once (`chittu-v3.html:1033`, `:1120`) and the router now
matches it. Both paths append only when the history does not already end with
the turn, because `generate()` and `classify()` are public ports and a caller
may hold either convention.

**2. Adapter-side control-token stripping DEFEATED the kernel's.** The kernel's
`stripControlTokens` *slices* at the last `</think>` and keeps what follows. The
adapter replaced `<think>` and `</think>` with spaces first — deleting the
delimiter the kernel needs, so the slice never happened and the reasoning was
welded onto the answer:

```
vendor:            <think>she said she wants to die</think>CRISIS
kernel alone:      CRISIS                                   -> crisis lock fires
adapter -> kernel: she said she wants to die CRISIS         -> matches nothing
```

The sandbox's escalation tokens are compared EXACTLY, so that turn locks
nothing, shows no helplines, flags no parent — and renders the model's reasoning
about a child's self-harm to that child. L6 does not catch it: it tests for
banned content, and reasoning is not banned content. `packages/pipeline/src/index.ts:362-363` names this exact
string — *"a self-hosted model emits `<think></think>CRISIS`, and
`<think></think>CRISIS` !== `CRISIS`"* — and the guard written for it was being
disarmed one layer earlier.

Latent for Anthropic, which returns thinking as a separate content block that
the adapter filters out. Live the moment any vendor emits inline reasoning —
which is the entire premise of phase 3, and of `chittu-local`.

**The fix is that the adapter now strips NOTHING** and hands the reply over as
the vendor wrote it. The kernel's slice already runs on the sandbox reply, in
the pipeline, for every vendor. The adapter's only job was to stop destroying
its input.

**A first version of this fix was wrong and is worth recording.** It moved
`stripControlTokens` into the router's `callAdapter` so that it ran for every
category — "so no adapter can forget". That broke the classifier and lost a
crisis `main` catches:

```
verdict: {"label":"CRISIS","memory":null,"assist":"STRUGGLE: pasted </think> at school"}
  main      -> CRISIS
  that fix  -> parseClassifier: not JSON  ->  FAST-PATH-ONLY
```

`i want to disappear` does not trip L1; on that turn L2 is the only wall. The
slice is correct for prose and wrong for JSON, so it stays on the path that
carries prose. Caught by an adversarial review before it landed, not by the
suite — every test in the change was green.

**3. `controlTokens` is a port member that does nothing.** Declared in
contracts, documented in architecture §12.1 as *"what to strip from THIS
provider's output"*, set by the one adapter — and read by no code at all.
Pointing it at a pattern matching nothing breaks zero tests.

**NOT FIXED, deliberately.** Making it live means applying it, and applying it
as a delete after the kernel's slice re-creates defect 2 for any vendor whose
delimiters are not `<think>`: no `</think>` to slice on, then the vendor's own
delimiters deleted, then the reasoning welded back on. Demonstrated in review
with a ten-line adapter. The field cannot express the difference between a
DELIMITER (slice, keep what follows) and LITTER (delete), so honouring it
correctly is a contract change. Recorded here as a known-dead member rather than
papered over with a live one that is wrong.

**4. `ProviderError.retryable` was hardcoded `true` on the escaping error**,
including for failures the retry loop had just declined to retry. Nothing reads
the field today, which is why it survived; §12.3's promised
fall-back-to-a-cleared-cell policy is exactly what would read it. Fixed: the
escaping error reports what the loop actually decided.

**Mutations, each verified to go red:**

| mutation | tests that fail |
|---|---|
| the adapter strips control tokens again | 3 |
| the sandbox appends the turn unconditionally | 1 |
| the classifier window appends unconditionally | 2 |
| `retryable` hardcoded `true` again | 1 |

---

### KNOWN AND OPEN — two further defects the same review found

Both pre-date this change and neither is fixed here; both are in `main` today.

**FIXED 2026-08-25 — see the entry below.** ~~The `</think>` slice fires on ONE spelling.~~ `stripControlTokens` slices on a
case-sensitive `indexOf('</think>')` while deleting via a `/gi` pattern, so
`<thinking>`, `<reasoning>`, `<THINK>`, `</think >` and `<tool_call>` are all
deleted rather than sliced — and weld exactly as `<think>` used to. Driven end
to end through the shipped adapter and the real pipeline, four of five spellings
render the model's reasoning to the child with `crisisLock: false`.

This is already pinned as an intended "ported gap" in
`packages/safety-kernel/src/output-filter.test.ts:244-256`. It is a **kernel**
change under the port-semantics rule ("changing them is a Guardian Council
decision, not a port decision"), so it is not made here. What is corrected here
is the claim: fixing `<think>` closes one spelling, not the class.

**The L6 branch deletes the CHILD's turn, not the model's.**
`packages/pipeline/src/index.ts` does `history: afterCls.history.slice(0, -1)`
with the comment *"drop the poisoned turn"* — but the poisoned assistant reply
was never appended, so the last entry is the child's own message. After an L6
block the child's words vanish from the classifier's three-turn window, and the
next sandbox call opens with an `assistant` message. The prototype avoids this
structurally by keeping `S.recentKid` separate from `S.history`; the port
collapsed them.

---

### BLOCKED (2026-08-25) — Gemini's own terms forbid the use phase 3 proposes

`docs/chittu-model-plan.md` §3 names Google Gemini as the second provider, on
the strength of LearnLM's pedagogy record. Before writing the adapter, the
Gemini API Additional Terms of Service were read. Verbatim, from
<https://ai.google.dev/gemini-api/terms>:

> "You must be 18 years of age or older to use the APIs."

> "You also will not use the Services as part of a website, application, or
> other service (collectively, "API Clients") that is directed towards or is
> likely to be accessed by individuals under the age of 18."

Chittu is a service directed towards individuals under the age of 18. That is
not a Seat 10 judgement call about residency or retention; it is the published
contract prohibiting this category of use. The plan was careful to rule OpenAI
out on exactly this ground (landscape #19, COPPA) and did not apply the same
test to Google.

Two further facts from the same page, which bear on any successor decision:

> unpaid tier: "To help with quality and improve our products, human reviewers
> may read, annotate, and process your API input and output."

> paid tier: "Google doesn't use your prompts … or responses to improve our
> products"

A free-tier call would put a child's turn in front of a human reviewer and into
Google's training data. Only the paid tier is even discussable.

Separately, `generateContent` is now labelled legacy in favour of an Interactions
API which, from <https://ai.google.dev/gemini-api/docs/interactions>, "stores all
Interaction objects (`store=true`)" by default and retains them **55 days** on
the paid tier. A vendor holding 55 days of a child's turns cannot be reconciled
with requirements §9.2, where revocation must propagate and W5 promises erasure
by crypto-shred — a shred reaches our database and not Google's. If Google is
ever used, it is `generateContent` with its statelessness as the stated reason,
or the Interactions API with `store=false` and that flag asserted in a test.

**No adapter was written.** Building one against an endpoint we are contractually
barred from calling would be inventing confidence, and the likely successor —
Vertex AI under Google Cloud terms — has a different host, a different path and
service-account auth, so most of what was written would be wrong anyway. The
decision is recorded in the model plan §5 as a question for a human.

### OPEN (found 2026-08-25) — the role separation is DECLARATIVE, not enforced

`docs/chittu-schema.sql` ends with a comment calling the absent grants "the
control": *"chittu_app is granted nothing on training_signal … The runtime
cannot reach the training corpus."* Phase 2 of the model plan stopped at
`signal_counter` out of respect for it, and phase 4 had to cross it — which is
when somebody finally checked whether it was true.

It is not, in any environment. Probed directly:

```
runtime connects as : postgres          <- the table OWNER
roles               : chittu_app NOLOGIN, chittu_ops NOLOGIN
runtime INSERT into training_signal -> ACCEPTED
child FORCE ROW LEVEL SECURITY      -> false
```

Both roles are `NOLOGIN`, so nothing can connect as either. PGlite connects as
`postgres`; compose and `test:pg` connect as `chittu`; the RDS module would use
the master user. An owner holds every privilege implicitly and bypasses
row-level security, and `FORCE ROW LEVEL SECURITY` is set on no table — so even
an owner that did `SET ROLE` would be exempt.

**The same defeat takes RLS with it.** The five policies scoped `TO chittu_app`
are inert for the same reason. What actually protects a child-scoped query today
is `assert_child_scope()`, which RAISES rather than filtering — a different
mechanism, and a good one, but not the one the comment describes.
`packages/db/src/index.test.ts` is the only place the model is exercised, under
`SET LOCAL ROLE chittu_app`, and it passes: the specification is correct and
nothing runs it.

**Phase 4 did not fix this, and did not pretend to.** A non-owner runtime role
needs a second credential and deployment configuration that has never been
applied (`infra/` has never seen a `plan`). Doing it piecemeal — ops as a
restricted role while the runtime still owns the tables — constrains the surface
that is already the most supervised and leaves the one that is not. What phase 4
did instead: made the writes visible (operator-authenticated, four-eyes,
`authored_by` from the session), added the grants the specification was missing,
and rewrote the comment so nobody reads a control into it. See the schema's §11
header and the note above the final GRANT block.

**And the grants were incoherent with the code.** `chittu_ops` had SELECT only
on `training_signal`, `training_example` and `signal_counter`, while
`signalRepo.promote()` INSERTs and UPDATEs; `chittu_app` had no DELETE on
`signal_contributor`, which `observe()` performs at the k-anonymity floor —
inside a try/catch that logs and continues, so under the intended role the one
table designed to stay bounded would have grown forever, silently. Migration
0006 fixes all four.

### FIXED (2026-08-25) — `training_example.label` was unconstrained free text

The same file CHECKs the five-token vocabulary twice on `training_signal`
(`observed_token`, `expected_token`) and left `label` — the value a trained
model learns to EMIT — as `text`. An out-of-vocabulary label is how a
scripted-response guarantee gets violated quietly, a year later, in a dataset
nobody re-reads. Now `CHECK (label IS NULL OR label IN (…))`; nullable stays
legal because a SAFE example need not carry one.

### FIXED (2026-08-25) — the `</think>` slice fired on one spelling in eight

Recorded in the entry above as pre-existing, and pinned in
`packages/safety-kernel/src/output-filter.test.ts` as an accepted **"ported
gap"** whose comment called it a leak of reasoning "as text". Driven end to end,
it is not that.

`stripControlTokens` tested `indexOf('</think>')` — one case-sensitive literal —
while DELETING four tag names through a `/gi` pattern. So the delimiter the
slice needs was removed for every spelling the slice could not see:

```
FIRES   "<think>she said she wants to die</think>CRISIS"         -> "CRISIS"
MISSED  "<thinking>she said she wants to die</thinking>CRISIS"   -> "she said she wants to die CRISIS"
MISSED  "<reasoning>…</reasoning>CRISIS"                         -> "she said she wants to die CRISIS"
MISSED  "<THINK>…</THINK>CRISIS"                                 -> "she said she wants to die CRISIS"
MISSED  "<Think>…</Think>CRISIS"                                 -> "she said she wants to die CRISIS"
MISSED  "<think>…</think >CRISIS"                                -> survives whole, brackets included
MISSED  "<tool_call>…</tool_call>CRISIS"                         -> "she said she wants to die CRISIS"
MISSED  "<|a|b|>CRISIS"                                          -> survives whole
```

One in eight. The escalation tokens are compared with `===`, so each of the
other seven locks nothing, shows no helplines, flags no parent — and renders the
model's reasoning about a child's self-harm to that child. **L6 is not a
backstop for it**: `passesOutputFilter('she said she wants to die CRISIS')` is
`true`, because reasoning is not banned content.

**This is a Guardian Council decision and it was taken deliberately.**
`output-filter.ts`'s header says the ported regexes' known gaps are "left
intact; changing them is a Guardian Council decision, not a port decision". The
gap was recorded when it looked cosmetic. It is not, and the correction errs in
the safe direction by construction: a wider slice keeps strictly **less** of
what a model said, never more.

**Changed in all three copies together**, which is what CLAUDE.md requires: the
kernel, `apps/web/src/safety/render-guard.ts` (the deliberate duplicate) and
`prototype/chittu-v3.html`'s `stripThink` (the reference). `render-guard.test.ts`
pins the first two and fails on drift — proved by mutating the client back,
which fails 10 tests.

**One behaviour genuinely changed, and it is worth arguing rather than
adjusting.** `'Answer</tool_call>'` returned `'Answer'` and now returns `''`. A
close tag CLOSES reasoning, so text before one is reasoning by definition —
which is already how `'<think>reason</think>'` behaved. The cost is that a model
emitting a real answer followed by a stray close tag now yields the friendly
fallback via L6. A degraded turn, chosen over the alternative, because keeping
text on the "before the close tag" side is exactly what welded a model's
reasoning onto its answer.

**And a defence that was not one.** The first version reset `lastIndex` around
an `exec` loop. Deleting both resets broke zero tests — because a loop that runs
to `null` has already been reset by `exec` itself, so the reset is unreachable.
Replaced with `matchAll`, which clones the regex and has no state to get wrong,
and the purity test now asserts the property (same input, same answer, forever)
rather than the mechanism.

Mutations, each verified red: the one-spelling literal → 26; no slice at all →
33; no whitespace tolerance → 4; special tokens without a pipe → 3; the client
drifting back → 10.

### FIXED (2026-08-25) — the real-Postgres lane had an extension race

`createTestDb()` runs `CREATE EXTENSION IF NOT EXISTS … SCHEMA public`, and
`IF NOT EXISTS` is **not atomic**. Two fixtures starting at the same moment on a
database nobody has used yet both see "not present", both create, and one loses:

```
error: duplicate key value violates unique constraint "pg_extension_name_index"
  at Module.createTestDb packages/db/src/testing.ts:73
```

Reported as an entire test FILE failing at collection with all of its tests
skipped, intermittently. It appeared when phase 4 added a fourth concurrent
caller and has presumably been there since the second.

**The part worth remembering is why three green runs proved nothing.** It only
reproduces on a database nobody has touched — exactly what `pnpm db:up` makes,
and exactly what a rerun does not. Three consecutive passes against a warm
database said nothing at all, and the fix was only confirmed by tearing the
container down between runs. Now serialized under a transaction-scoped advisory
lock; verified across three cold starts.

### NOTED — one prototype Playwright test is flaky under parallel load

`tests/pipeline.spec.js › tapping a chip sends it as the next message` failed
once during phase 4's verification with the typing indicator (`●●●`) still on
screen — the assertion outran the reply. Passes 3/3 in isolation, and phase 4
changed no prototype file. Recorded rather than fixed: it is a
`expect.poll`-on-the-wrong-condition problem in a suite this change does not
touch, and guessing at it blind is how a flake becomes two.

### NOTED — the ops console's identity is a shared bearer token

`authored_by` and `reviewed_by` on `training_example` are the four-eyes record,
and what stands behind them is `CHITTU_OPS_TOKENS` — a name-to-token map in the
environment, with no revocation, no rotation and nothing binding a token to a
person. Two people sharing one token are one operator to this system, and one
person holding both tokens is two. The constraint is real; the identity behind
it is as good as the token discipline. Recorded rather than solved: solving it
means real accounts, which is a bigger change than phase 4.

### NOTED — the classifier cell is a substitution, not the design

§12.2's finding is that there is no kid-safety classifier to buy, and the
intended engine for L2 is our own self-hosted `chittu-local`. It is not
deployable yet (§13.2, and the CRISIS 3/8 scorecard), so the cell points at
Haiku 4.5 today. `DEFAULT_CELLS` says so in a comment; it is a placeholder with
a name, not a decision.

### FIXED (2026-08-25) — clearance is now per-child

`provider_clearance` is keyed by `(provider, jurisdiction)`, and the honest
per-turn check uses the child's own country. `classify()` received no country —
the port passed text and history — so the router required a provider to be
cleared for **every enabled market**, an intersection. That erred toward calling
fewer vendors, which is the safe direction, but it was coarser than the schema
supports: a vendor cleared for India and not the UK was unusable for Indian
children too.

The port now carries a `RouteContext` — band and country, and deliberately
nothing else, because anything else handed to a router is something it could
then route on. `readClearance` returns `byCountry` alongside the intersection,
and `route()` asks the question the table actually answers whenever it has a
context.

The intersection has not been deleted. It is still what a caller with no turn in
hand gets — a health check, an ops command — because a route with no country
cannot be checked against one. Two answers, and which you get depends on what
you know.

Mutation-tested both ways: removing the per-country check, and dropping
`toJurisdiction` so GB stops matching UK, each fail exactly one test.

### FIXED — GB and UK were never going to match

`Country` in contracts uses `GB`; the schema's `jurisdiction` enum uses `UK`.
A clearance row for the UK would never have matched a British child, and the
failure mode is silent in the dangerous direction: a check that finds nothing to
fail against. `toJurisdiction()` maps it, with a test.

### NOTED — two schema controls fired during verification

Enabling a market with no verified helplines is refused by a trigger
(`market_needs_helplines`), and `provider_clearance` refused an expired row.
Neither was written for this change; both did their job unprompted, which is
what the constraints-carry-the-doctrine approach is supposed to feel like.

---

## The helpline sweep (GAP-06)

### FIXED — the registry could rot silently

`helpline_registry` existed and nothing read it: `GET /v1/helplines/:country`
and the crisis script both served the compiled-in constant, so a number could
only be corrected by a deploy, and a number going dead had no way to be noticed
at all.

Now: an hourly sweep moves overdue rows to `stale` and alerts; the crisis script
and the route both resolve through the registry; and
`docs/runbooks/helpline-p0.md` plus a small CLI make the human half actionable.

**The compiled-in `REGISTRY` stays the floor.** The crisis path never waits on a
query — if the table is missing, empty, or the database is unreachable, a child
still gets the numbers we shipped. What the table buys is correction in minutes
rather than a release cycle, verified end to end: a corrected Indian number
reached a crisis reply with no deploy and no restart.

### The rule that took the most thought — `stale` shows the numbers anyway

| state | what a child gets | why |
|---|---|---|
| `verified` | the registry's numbers | someone checked |
| `stale` | **the registry's numbers, unchanged** | overdue is not wrong |
| `P0_WRONG_NUMBER` | the compiled-in numbers | a wrong number is worse than none |

Withholding a probably-correct helpline from a child in crisis because *our*
re-check date slipped would punish the child for our process failure. Staleness
pages an adult; it does not edit the script. A mutation that made `stale`
withhold — the tempting "safe" reading — fails two tests.

### NOTED — the sweep does not dial anything, and cannot

No API tells you whether a national child helpline still answers. The job
notices a date has passed and pages a human; **the human is the verification.**
That is a smaller claim than "verified helplines" and is deliberately smaller —
the registry without the sweep was a table that silently rotted, and that is
what this closes, not more.

`import` reflects the same honesty: rows land as `import:builtin (UNVERIFIED)`
with `next_sweep = now()`, so the next sweep immediately marks them stale and
pages. Writing `verified` with today's date because a script ran is exactly the
lie the table exists to prevent.

### FIXED — GB would have run on the fallback forever

`Country` says `GB`; the `jurisdiction` enum says `UK`. `'GB'::jurisdiction`
raises, `resolveHelplines` catches errors and falls back — so every British
child would have silently got the compiled-in numbers, with a log line as the
only symptom. It broke the very first `import` run, which is the only reason it
was found; the router PR had already flagged the mismatch and mapped it in one
place while the helpline path went in unmapped.

There is now **one** `toJurisdiction`, in the package that owns the enum, applied
at every boundary. Removing it fails 3 tests.

### NEEDS A DECISION — two G3 blockers remain, both named in the runbook

1. **Alerts go to the log, not a pager.** `AlertPort` is the seam. Until it is
   wired, the guarantee is "somebody is reading logs", which is weaker than this
   gate needs.
2. **The sweep runs in-process on a timer.** A job that runs only while one API
   process is up stops when that process does. The production shape is a
   scheduled task (§14).

### FIXED DURING THE WORK — a deadlock this repo had already met once

The first draft resolved helplines from `opts.pool` while inside
`store.withChild`'s transaction. PGlite has one connection, so the whole API
suite hung rather than failed — no error, just a test run that never finished.
PORT-REVIEW already recorded this exact failure from the persistence layer.

`resolveHelplines` now takes `Db | DbPool` with the reason in the signature's
doc, so "which handle am I on?" cannot be fudged a third time.
