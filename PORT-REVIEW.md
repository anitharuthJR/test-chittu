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

**PGlite was removed on 2026-08-25, so this class of bug no longer announces
itself.** The single connection was an accidental detector — it caught this twice
(see also the helpline-resolution entry). Against a pool the same mistake reads a
stale snapshot and passes. Nothing replaced the detector; the rule in CLAUDE.md
("never read from `pool` inside a `withChild` transaction — take the caller's
`tx`") is now enforced by review alone.
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

### RESOLVED (2026-08-25) — what PGlite did not test

PGlite was real Postgres (WASM), so constraints, triggers, RLS and plpgsql were
the genuine article with no container to run. Three things it did not cover:
`CREATE EXTENSION vector`, the `vector(1024)` column and the HNSW index were
shimmed out; there was only one connection, so lock contention and serialization
failures were unexercised; and it was not the RDS binary.

The suggested fix here was to ALSO run the suite against a container. What
actually happened is that PGlite was removed and the container became the only
lane — because the escape hatch built for the divergence (`TestDb.supportsVector`)
was read by no test, so the gap was silent rather than handled, and because the
container turned out to be FASTER: 207 DB-backed tests in 38.3s against PGlite's
48.4s. Two of the three gaps are now closed outright. The third stands: this is
the pgvector/pgvector:pg16 image, not the RDS binary.

See `docs/superpowers/specs/2026-08-25-remove-pglite-design.md`.

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

**FIXED 2026-08-25 — see below.** ~~The L6 branch deletes the CHILD's turn.~~
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

Both roles are `NOLOGIN`, so nothing can connect as either. The suite and the dev
stack connect as `chittu`; the RDS module would use the master user. An owner holds every privilege implicitly and bypasses
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

### FIXED (2026-08-25) — one array was the model's context AND the classifier's window

Recorded above as "the L6 branch deletes the CHILD's turn". Following it to its
root found something larger: `SessionState.history` was doing two unrelated
jobs, and the port had collapsed a separation the prototype keeps deliberately.

**Three harms, all confirmed by probe.**

*A guarded turn was sent to the vendor on the NEXT turn.* The child's turn was
appended to `history` before any guard ran, so:

```
turn 1  "my phone number is 9876543210"  ->  PII GUARD · scripted, 0 vendor calls
turn 2  CLASSIFY: [..., "my phone number is 9876543210", ...]
turn 2  SANDBOX:  ["user:my phone number is 9876543210", ...]
```

"A crisis turn makes zero vendor calls" was true of that turn and false of the
one after it. Crisis itself is covered by the lock; PII, UNSAFE, SECRET and
IDENTITY are not.

*An L6 block deleted the child's turn from the classifier's window.*
`history.slice(0, -1)`, commented "drop the poisoned turn" — but the poisoned
thing was the model's reply, which was never appended. What it dropped was the
child's own message, from the window of the layer whose entire job is patterns
across turns, and it dropped the one turn most worth having context on.

*And it left the context permanently malformed.* After a block, `history` began
with the scripted fallback and no user turn in front of it:

```
turn 2 sandbox context: ["assistant:My words got a bit tangled…", "user:what should i do"]
turn 3 sandbox context: ["assistant:My words got a bit tangled…", …]     <- never recovers
```

Anthropic requires the first message to be `user`, so every later turn in that
session would have failed — non-retryable, to `SANDBOX · unavailable`, which is
the same friendly fallback. A child whose first turn tripped L6 would have had a
session that never worked again and never said why.

**The fix restores the prototype's two structures.** `history` is the model's
context: real exchanges only, entered at the sandbox on a candidate state and
committed only when the sandbox produced a usable answer. `recentKid` is the
classifier's window: every turn the child sent, never removed. `reply()` gained
`intoModelContext`, defaulting to FALSE so a guard path added later leaks nothing
by forgetting; exactly one call site passes true.

**What was NOT done, and why.** The classifier still sees guarded turns. Its
window exists for "escalating secrecy, boundary-testing, repeated distress"
(`CLASSIFIER_SYSTEM`), and the guarded turns are the boundary-testing —
withholding them would blind the one layer built to notice. The prototype pushes
to `recentKid` at `chittu-v3.html:1041`, *before* the L1 fast path at `:1060`,
for this reason. The invariant is narrower than "a guarded turn never leaves the
process": a guarded turn reaches the layer that judges safety, and never the
layer that makes small talk.

**The port change.** `classify(text, recentKid: readonly string[], ctx)` — it was
`history` (role-tagged, both sides) and the router filtered it down to the user
messages. That filter looked load-bearing while hiding the fact that one array
was serving both jobs.

**Storage.** `recentKid` joins `history` in `session.runtime_enc`, trimmed to the
same window. `readRuntime` now spreads over the empty shape, so a blob written
before a field existed parses without it instead of announcing itself as
`undefined.slice` on a live session mid-turn.

Mutations, each verified red: the turn joins the context before the guards → 7;
scripted replies enter the context → 4; the window comes from the context again
→ 5; the blocked exchange is committed → 1; a sandbox escalation is committed → 2.

### FIXED (2026-08-25) — the local provider was never ported

`prototype/chittu-v3.html` has had a second provider since v3:
`PROVIDER.mode = 'local'`, an OpenAI-compatible endpoint (chittu-v3.html:652),
with twelve Playwright tests behind it in `tests/local-provider.spec.js`. The
port carried the Anthropic branch across and left this one, and this register
did not record the omission — so "the router is real" was true of one vendor and
the claim it was written to support, that everything above `route()` is
provider-blind, had nothing testing it.

`apps/api/src/providers/local.ts` is that branch, ported. The wire is genuinely
different, which is the point:

```
              Anthropic                     local
path          /v1/messages                  /chat/completions
system        a top-level field             folded into messages[0]
auth          x-api-key header              optional bearer, usually none
reply         content[] blocks, typed       choices[0].message.content
```

The shape difference is not cosmetic. Sending Anthropic's body to this endpoint
produces a model that never saw its own system prompt — no error, no 400, just a
model behaving as though the fifteen hard rules were never written. That reads
as a bad model rather than a bad request, and it is exactly the class of failure
a second provider exists to make visible.

**It strips no control tokens**, and on this engine that matters more than
anywhere: a fine-tuned Qwen3 emits `<think>…</think>` as an artefact of its chat
template, so the reasoning preamble is the ordinary case and not the edge one.
Twenty-five tests, including the four escalation tokens driven end to end
through the real pipeline.

**Being in `MODEL_CATALOGUE` is not a promotion.** A cell still has to name it,
`provider_clearance` still has to clear it, and §13.2's gate still decides
whether the model is fit to answer a child. Phase 6 remains blocked on the Tamil
eval set.

**Two boot-time refusals were wrong once there were two providers**, and are
fixed with it: the production refusal read `ANTHROPIC_API_KEY === ''`, so a
deployment running the self-hosted lane alone would have been refused for
missing a key it does not use; and a cell naming a provider this deployment
cannot reach now refuses at boot rather than per-turn, because "routing
overrides IN EFFECT" is a statement about config and says nothing about
capability.

Mutations, each verified red: Anthropic's shape sent to an OpenAI endpoint → 1;
the adapter strips control tokens → 5; an empty completion treated as silence
→ 1; an absent token count reported as zero → 1. That last one was silent until
it was asserted on the ADAPTER rather than through the router, which fills
`?? 0` and makes "the server said nothing" and "the server said zero" the same
value.

### FIXED (2026-08-25) — `session.runtime_enc` was where a teen's words lived

Session 001 ruled that a teen's message body is never stored.
`teen_bodies_are_never_stored` enforces it on `message`, and `addMessage` agrees
with the constraint before it has to argue. `session.runtime_enc` did not: it
carries `history` and `recentKid`, both of which are the child's own sentences.

Probed end to end, in two processes so nothing survived in memory:

```
teen message rows WITH a body      : 0        <- the carve-out held here
teen session.runtime_enc bytes     : 215      <- and was defeated here
turn 2 sent the teen's turn 1 text : true     <- a full write-and-read round trip
```

**One column enforced it and another in the same transaction undid it.**

**The fix, and what it costs.** For a `thinker`, `history` and `recentKid` are
written empty. Nothing textual about a teen survives a request. The cost is the
one the schema comment named first: a teen's classifier window is now a single
turn, and their conversation carries no context between requests. L1, the
sandbox escalation tokens and L6 are unchanged — it is L2 that loses its window,
for the band whose turns most need it. The comment asked Chamber II to decide
whether the trade was right; the trade has now been made in the other direction,
and it should be reviewed as such rather than assumed settled.

**Abstraction is not a way out, which is worth recording because it is the
obvious idea.** `abstractShape` destroys DISTINCTIVE tokens, not meaning:

```
"i cut myself last night and mum doesnt know"      ->  unchanged, verbatim
"he keeps asking me to send pictures and i said no" ->  unchanged, verbatim
"i have not eaten properly for three days"          ->  "i have not <OOV> properly for three days"
```

A shape of a disclosure is the disclosure. Two designs could buy the window back
without storing words, and both are decisions rather than implementations:

- **A label-only window** — the L1 kind and L2 label per turn, no text, in the
  shape `flag` already uses. Recovers "escalating secrecy" without a sentence.
- **A per-session key in an httpOnly cookie**, so the blob is unreadable without
  the child's own browser and becomes permanently unrecoverable when the session
  ends — a per-session crypto-shred that happens by itself.

**And a second channel found while sweeping for the first.** `state.assists`
accumulates `outcome.assist` — whatever string the classifier returned, which
`parseAssist` accepts unconstrained — and is read by NO code anywhere. The
parent-facing record is the `flag` row, whose `assist_topic` is CHECKed to
`^[a-z0-9 \-]{1,40}$` precisely so it cannot become a free-text field by drift.
This array had no such guard and no purpose. It is no longer persisted for any
band; nothing observable changes and less is stored.

`state.topics` was checked too and is clean: the port only ever writes fixed
guard labels and the literal `'maths'`. The prototype's
`text.split(' ').slice(0,2)` — the first two words of the child's turn — was not
ported, which is lucky rather than deliberate and is now noted.

Mutations, each verified red: the model context persisted for teens → 2; the
window persisted for teens → 2; the carve-out never applies → 2; assists
persisted → 2.

### SUPERSEDED — `session.runtime_enc` is still where a teen's words live

Unchanged by the above, and already flagged in the schema: for a `thinker`,
`message.body_enc` refuses the body and `runtime_enc` holds it, so the blob is
the one place a teen's words are written down. `recentKid` now joins `history`
there, which is the same class of data in the same place for the same stated
reason — the classifier's window, for the band whose turns most need context.
The schema comment asks Chamber II to decide whether that trade is right; it
still does, and this change did not make it for them.

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

### FIXED (2026-08-25) — the same race again, one object over

`CREATE ROLE` is wrapped in a `DO` block catching `duplicate_object`, so the
schema is re-runnable. Two fixtures starting at the same instant on a fresh
database both look, both find nothing, and both proceed — and the loser gets
`unique_violation` on `pg_authid_rolname_index`, a different SQLSTATE for the
same situation. Not caught, so a whole test file failed at collection with all
32 of its tests skipped.

Identical in shape to the extension race below, found the same way — a cold
database — and it says something about the class: **an existence check followed
by a create is not atomic, whatever the object is, and "it is already there" and
"somebody else just made it" are different errors.** Both exceptions are caught
now; verified across three cold starts.

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

### FIXED (2026-08-25) — the flaky prototype Playwright test, and why it was never luck

`tests/pipeline.spec.js › tapping a chip sends it as the next message` failed
once during phase 4's verification with the typing indicator (`●●●`) still on
screen — the assertion outran the reply. Passes 3/3 in isolation, and phase 4
changed no prototype file. Recorded rather than fixed: `expect.poll` on the
wrong condition, and guessing at it blind is how a flake becomes two.

**It is no longer blind.** It failed twice more inside `pnpm verify` on
2026-08-25, on a loaded box, and the captured page state names the mechanism:

```
teach me something
Pick one!
↳ SANDBOX (LAW 05) · CLASSIFIER·MODEL·WINDOW(3)
Volcanoes          <- the CHILD's turn, rendered by the chip tap itself
●●●                <- the typing indicator; Chittu's reply has not arrived
```

```js
const before = await page.locator('#msgs .msg').count();
await page.locator('#msgs').getByText('Volcanoes', { exact: true }).first().click();
await expect.poll(() => page.locator('#msgs .msg').count(), { timeout: 10000 })
  .toBeGreaterThan(before);                       // <- satisfied by the CHILD's message
expect(await allMessages(page)).toContain('magma rises');   // <- the reply, not yet there
```

**The wait is structurally incapable of waiting for the thing asserted.** Tapping
a chip renders the child's own message immediately, so `count > before` is true
before any model call resolves — the poll returns on the tap, not on the reply.
Under low load the reply happens to land inside the poll's first interval and the
test passes for a reason unrelated to what it checks; under load it does not.
Same shape as §8b's recurring pattern: an instrument reporting success while
measuring something else.

The fix is to poll the assertion rather than a proxy that becomes true too early:

```js
await expect.poll(() => allMessages(page), { timeout: 10000 }).toContain('magma rises');
```

**FIXED, on the owner's instruction.** The wait now polls the asserted text
(`allMessages` contains `magma rises`), which cannot be satisfied early and
cannot be off by one again. Two assertions were added while there: the chip's
text became the child's turn — the claim in the test's NAME, and previously not
asserted at all — and the count check the original was reaching for, with the
`+ 1` the shared helper always had.

**Proved by construction rather than by re-rolling the dice.** A throwaway spec
delayed the second sandbox reply by 1.5s — what a slow machine does — and ran
both waits against it. The old wait returned immediately with `magma rises`
absent and `●●●` on screen; the new one waited and found the reply. That is the
mechanism demonstrated, not a flake caught.

**And a negative result worth recording, because it says what the trigger is
NOT.** Saturating the CPU (2–3 spinners per core) did not reproduce the failure:
the OLD wait passed 3/3 under it, as did the new one. So the trigger in `pnpm
verify` is not raw CPU contention — more likely the cold browser start and page
cache pressure of running immediately after the 65-file vitest lane and its
Postgres container. Load was the wrong lever; the delay injection was the right
one. Anyone tempted to reproduce this by making the box busy should not bother.

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
`store.withChild`'s transaction. PGlite had one connection, so the whole API
suite hung rather than failed — no error, just a test run that never finished.
PORT-REVIEW already recorded this exact failure from the persistence layer.

That detector is gone with PGlite (2026-08-25): on a pool this would have read a
different snapshot and passed.

`resolveHelplines` now takes `Db | DbPool` with the reason in the signature's
doc, so "which handle am I on?" cannot be fudged a third time.

## 11. The four diagram nodes the build half-delivered

### FIXED (2026-08-25) — the boot banner disagreed with the server it described

`main.ts` answered "is the grounded corpus live" with its own
`router.route('embedding')` call — a second opinion about a decision
`buildServer` makes elsewhere — and it was wrong in **both** directions.

**The stub router reported ON.** `stubRouter().route()` answers every category
with `{provider:'stub', model:'stub-0'}` and never throws, so a dev boot printed
`grounded corpus: ON — stub/stub-0` while `embedderFor` returned null, no
grounding port was wired, and no walk ever contained CORPUS. A route resolving
is not evidence of a capability; the same defect class as the CORPUS layer stamp
that sat beside a bare `detectSubject()` call for months, and in the lane where
people form their mental model of what is live.

**And the more serious half, found while fixing the first: an Anthropic-only
deployment reported OFF and stamped the layer anyway.** `createRouter` always
defines `embed`, so `embedderFor(router)` returns a live embedder even though
`DEFAULT_CELLS.embedding` names `local` and no local adapter exists. The port
was therefore wired, `CORPUS` was stamped on **every sandbox turn**, and every
retrieval reported `CORPUS UNAVAILABLE` — under a banner that said `OFF` and a
follow-up line that promised "no CORPUS layer will be stamped". That is every
Anthropic-only deployment, which status §2b says is all of them. Confirmed by
driving a real turn: `layers` contains `CORPUS`, `trace` contains
`CORPUS UNAVAILABLE`.

**CLAUDE.md described the behaviour that did not exist.** Its invariant read
"no grounding port is wired, no CORPUS layer is stamped, and the boot banner
says `grounded corpus: OFF`". One clause of three was true. Corrected there too.

**The fix is structural, not a better guess.** `corpusStatus(router, embedder)`
takes the embedder `buildServer` actually wired and is computed three lines from
where `groundFor` is decided; the server hands it out as `app.corpus`, and
`main.ts` prints that. The banner is no longer a second opinion about the
wiring — it is the wiring, printed.

**Three states, because the deployment has three, named after what a TRACE will
look like:**

| state | what a walk contains | what it means |
|---|---|---|
| `off` | no CORPUS layer, ever | no embedder wired (the stub) |
| `unavailable` | CORPUS on every turn, all `CORPUS UNAVAILABLE` | an embedder is wired and routing refuses it |
| `on` | CORPUS, `GROUNDED CORPUS` or `CORPUS MISS` | wired and routable |

Collapsing `off` into `unavailable` is the identical mistake the pipeline's four
grounding outcomes exist to prevent one level down. `off` is a fact about the
BUILD; `unavailable` is a fact about ROUTING; only one of them explains a trace
full of UNAVAILABLE, and only one is worth waking somebody for.

Verified on the real boot log, both shapes:

```
[chittu] grounded corpus: OFF — no embedder is wired; no CORPUS layer will appear in any trace
[chittu] grounded corpus: UNAVAILABLE — an embedder is wired but routing refuses it: route refused for embedding via local: no adapter configured
[chittu]   every sandbox turn will stamp CORPUS and report CORPUS UNAVAILABLE — that is this refusal, not an outage.
```

Mutation-tested, per CLAUDE.md: reverting to the `route()`-only check fails 5
tests; collapsing `unavailable` into `off` fails 2; re-deriving
`embedderFor(router)` for the banner instead of reporting the wired embedder
fails 2. **That last mutation is silent against every test that does not inject
`opts.embed`**, because everywhere else the two values coincide — which is
exactly the shape of the original bug, so the injected-embedder case is the one
that has to exist.

#### Still open — the behaviour, not the banner

The banner is now honest about it, but **should an Anthropic-only deployment
wire a grounding port at all?** Today it does, and pays a `CORPUS UNAVAILABLE`
stamp on every sandbox turn for a refusal that cannot change without a restart.
Not wiring it would make `off` the correct state and remove the noise — but the
boot-time `route()` uses the CONSERVATIVE clearance rule (cleared for every
enabled market), so a provider cleared in IN and not GB would refuse at boot and
lose grounding for Indian children who are entitled to it, where the per-turn
check gets it right. The two refusal reasons need separating — "no adapter for
this cell's provider" is structural, "not cleared" is per-country — before this
can move. Left as-is: a change to what every trace in every deployment says is a
Council-level call on the four grounding outcomes, not a tidy-up.

### FIXED (2026-08-25) — D4's FOURTH CRISIS DETECTOR had no input channel

D4 draws four detectors converging on one crisis script. Three had an input:
L1's lexicon, L2's classifier, and the sandbox's escalation token on TEXT. The
fourth — what the picture shows — had none. `POST /v1/session/:id/turn` took
`{text, mode}` with `additionalProperties: false`, `apps/web` had no camera
control, and the router's `vision` cell (§12.2, `claude-sonnet-5`) was requested
by nothing at all: **configured and unreachable**. That is the same class of
defect as the CORPUS layer stamp with no retrieval behind it — it reads in
review as a working capability, and D3's "pictures the child shows" row and D2's
IMG attach both depended on it.

The prompt was in the same state. Rule IMAGES ("NEVER identify real people,
guess ages, or comment on bodies/looks … if the picture shows something unsafe
or upsetting, reply exactly `CRISIS`") has been in `sandbox-prompt.ts` since the
port, describing a thing that could not happen. It now has tests, because it is
now a live control.

**The image never becomes state, and the type system is what enforces it.**
`SessionState` is the value `saveTurn` writes to `message` and
`session.runtime_enc`, so anything on it is a thing that gets written down. The
image is therefore a PARAMETER of `runTurn` (fifth positional, beside
`ReadAttempt`) and a field of `SandboxInput` — neither of which is persisted —
and there is no field on `SessionState` it could be assigned to. `runtime_enc`
gains no key, so `teen-carveout.test.ts`'s whole-key-set assertion is untouched:
the question "what does this new field carry" never had to be argued, because no
new field was added.

**What IS recorded is that a picture was shown.** The seal chain gets one event,
`INPUT·IMAGE` / `image-shared(not stored)` — the prototype's own constant
(chittu-v3.html:1011), carrying no bytes and no description. A turn that reached
a vendor with no trace at all would be the opposite failure.

**Layer order is unchanged; a branch was added, nothing was moved.** The image is
read once, at layer 8, and handed to the sandbox port. L1 and L2 run on the
accompanying text first, which means a crisis phrase typed alongside a picture
still reaches zero models AND the picture is never sent — the guard fires two
layers above the sandbox. `runTurn` with a picture walks exactly the layers it
walks without one, asserted by comparing the two arrays.

**The cell is chosen by the picture, not by the mode.** A child in homework mode
photographing their worksheet needs a model that can see; the mode still shapes
the prompt, so the Socratic rules still apply. `vision` is metered as `vision` —
verified live: one turn produced `vision | anthropic | claude-sonnet-5` beside
the separate `classifier` row.

**Both adapters put the image on the wire, and the shapes differ.** Anthropic
wants `{type:'image', source:{type:'base64', media_type, data}}`; every
OpenAI-compatible endpoint wants `{type:'image_url', image_url:{url:'data:…'}}`.
Same bytes, different envelope, and neither vendor errors on the other's shape in
a way that says "you sent the picture wrong" — it just produces a model that
never saw it, which is indistinguishable from a model that cannot see. Exactly
the failure the second provider exists to make visible, and the same one
Anthropic's top-level `system` produces there. Pointing
`DEFAULT_CELLS.vision` at `local` still means pointing it at a model that can
actually see; `chittu-baseline` (qwen3:4b) cannot. Same rule as `embed` — **a
capability is not something a cell assignment can confer** — the difference
being that `embed` is a separate method and can be refused, while a vision model
and a text model share `complete()`. That refusal has nowhere to live today and
is left as a known gap below.

**The route was WIDENED, not loosened.** `additionalProperties: false` stays, on
the body and on the image sub-schema. `mimeType` is an enum, `dataBase64` is
length-capped at `IMAGE_MAX_BASE64_CHARS` and pattern-checked to the base64
alphabet, so a `data:` URI or an unknown format is a 400 here rather than a
string handed to a vendor's parser. `bodyLimit` is raised on THIS ROUTE ONLY —
raising it on the app would widen the DoS surface of consent drafts, PIN checks
and every ops route for one route's benefit.

Verified in the running app on 2026-08-25, against the real Anthropic adapter
pointed at a local stand-in: the classifier call carried the child's text as a
plain string with no image; the sandbox call carried `["image","text"]` on the
last user turn, `image/png`, 444 base64 chars, and those bytes appeared nowhere
else in the request; the model answered `CRISIS`; the chat locked with the
scripted spine and India's registry helplines; the flag read `SAFETY /
CRISIS_DISTRESS` with no topic; and a sweep of every text column in the schema
for the picture's base64 returned nothing while a positive control found what it
was meant to.

Mutation-tested, per CLAUDE.md: keeping the picture in the model context fails 5
tests, sealing the image bytes fails 1, dropping the `vision` routing fails 3,
an adapter that silently drops the picture fails 1, and loosening the image
sub-schema fails 3.

#### Still open

- **A provider without vision cannot refuse.** `router.embed()` refuses a
  provider whose adapter has no `embed`, because an embedding is a separate
  method. A vision model and a text model share `complete()`, so a `vision` cell
  pointed at a text-only model sends the picture and gets a reply that ignored
  it — no error anywhere. Expressing that needs a capability on
  `ProviderAdapter` that `route()` checks, which is the same shape as the
  `controlTokens` question and, like it, is not a tidy-up.
- **One image per turn, and text is required.** The schema takes a single
  `image` and `text` stays `minLength: 1`, matching the prototype, which will not
  send on an empty box. A child who wants to show a picture and say nothing has
  to type something. That is a product decision worth revisiting with children
  in the room, not a limitation of the pipeline.
- **The 4 MiB cap is the prototype's, carried over rather than re-decided.**
  ~5.6 MB of base64 on a low-cost Android on 3G is the device-floor question
  status §4 says has never been asked. The number should move on evidence.

### FIXED — D1/H, "Scripted welcome + one warm memory if any"

The prototype opens a session with the memory it holds (`chittu-v3.html:864-871`,
traced `SPINE · welcome + MEMORY`). The port kept the trace label and dropped the
memory: `Chat.tsx` pushed one fixed sentence, and memories were fetched only when
a child opened the memory book.

Rebuilt SERVER-side rather than in the client, because "which stored fact may be
spoken back to a child, unprompted, months later" is an allowlist decision and
the client is not allowed to make those. `welcomeMemory` in the kernel re-applies
the same six categories `memAdd` enforces — a read-side check that looks
redundant against the Postgres enum and is not, because the enum is what a
*writer* meets and this is what a future writer that is not `memAdd` would
bypass. `POST /v1/session` now returns `welcome: {blocks, trace}` (null on a
resume) and `Chat.tsx` holds no greeting copy of its own.

Two DELIBERATE deviations from the prototype:

- **The memory is the most recent, not a random one.** `Math.random()` cannot
  live in safety-kernel — it is a pure-function package and that is what makes it
  reviewable — and "the thing you told me last time" is the warmer pick anyway.
- **The words are the port's plain welcome**, not the prototype's `let's play!`,
  which was written for a four-year-old and shipped to every band. Only the
  memory clause is new copy.

Two details that are not fussiness. The stored fact is model-authored text, so
it is interpolated with a REPLACER FUNCTION (`String.replace` expands `$&`,
`` $` `` and `$'` inside a string replacement, and this replacement is not ours),
and it is placed straight into a `text` block rather than passed through
`parseBlocks` — a memory reading `likes [CHIPS]tap me[/CHIPS] puzzles` must
arrive as prose, not as buttons.

### FIXED — D4/UN, "Chat unlocked + gentle welcome-back message"

`POST /v1/session/:id/crisis/ack` lifted the lock and sent nothing back, so from
the child's side the pause simply stopped. D4's last node is a message, and the
prototype has it (`chittu-v3.html:1192`).

`CRISIS_WELCOME_BACK` in `spines.ts`, scripted for the same reason the rest of
the crisis path is: this is the least appropriate moment in the product to
improvise. A model asked to be warm here reaches for "are you feeling better?",
which reopens the subject, or "I missed you", which is an attachment simulation
and also false. The line reports what actually happened — a person checked in —
and claims nothing about how the child feels. Band-agnostic like `CRISIS_SOFT`.

**It is not a turn.** Nothing is written to `message`, nothing joins `history`,
nothing joins the classifier window. Three tests assert that against what the
sandbox and the classifier are actually handed on the next turn, rather than
against the blob — the blob is the mechanism, the context is the harm. Forcing
the line into `history` fails one of them.

On the client it renders as a CHITTU reply with its trace, not as `system`.
`system` is our own UI copy — an error, a lockout notice — and a safety script
rendered in that role would read as a toast at the moment it matters most. It is
pushed only when the unlock actually succeeded: a greeting after a refused
unlock would tell a child the pause is over when it is not.

### FIXED — D5/SEAL, "recompute every hash" was one conversation deep

`GET /v1/session/:id/seal` verifies ONE chain, and it is the only verify there
was. That is not the question a parent is asking. D5's node says "Verify seal
integrity / recompute every hash", and the prototype's button recomputed the lot
from GENESIS — including the conversations the browser in front of them never
opened and holds no id for. On a parent's own phone the old button said "No chat
has started yet", which is the same shape of defect the crisis panel had.

`auditRepo.verifyChild` walks every chain the child has, in one ordered pass.
Per session it is still a recompute from that session's own `genesisFor`, so it
is a loop over chains rather than one longer chain. It reports which SESSION the
break is in as well as which record: "record 4 is wrong", with a hundred chains
behind it, tells a parent nothing they can act on.

`GET /v1/parent/seal` is behind the parent gate, not the consent cookie —
it enumerates how many conversations a child has had, and a consent cookie alone
is a child. The per-session route is unchanged and still registered.

Tamper cases are tested by disabling the append-only triggers, which no test in
this repo had done before. `audit_event` refuses UPDATE and DELETE, so a broken
chain cannot be built through the front door — and the threat the seal answers
is a compromise of Postgres itself, where the attacker has the owner role and
can drop a trigger. Removing the prev-link check fails one test; removing the
hash recompute fails another.

**Still not caught, by either verify: a chain TRUNCATED at the tail.** What
remains recomputes end to end. `seal_anchor` exists for exactly this (heads
published outside the database, schema line 400) and is not populated. Noted in
the code, not fixed here.

---

## 12. NEEDS A DECISION — an unclosed block tag leaks its body as prose

**Severity: medium. Observed live. NOT fixed here — it is a faithfully ported
quirk, and changing it is a Guardian Council decision.**

`extract()` (`packages/safety-kernel/src/blocks.ts`) requires BOTH tags:
`TAG(name)` is `\[NAME\]([\s\S]*?)\[\/NAME\]`. When a model emits `[CHIPS]a|b|c`
with no `[/CHIPS]`, the match fails, `ANY_TAG` then strips the bare marker, and
the body survives as PROSE — pipe separators and all.

Observed 2026-08-25 against the real Anthropic sandbox, band `builder`. The child
saw:

```
Does Mani have a favorite spot to nap? 🌟Yes, a cozy spot!|On my bed|I'm not sure
```

It affects every tag, not just CHIPS: an unclosed `[FACT]`, `[STEPS]` or `[POEM]`
leaks identically. And it is not confined to the screen — `flatten()` is what the
seal chain hashes and what `speak()` reads aloud, so the malformed text is also
spoken with its separators and sealed in that form.

### The prototype does exactly the same thing

Checked first, as CLAUDE.md requires. `prototype/chittu-v3.html` `parseBlocks` is
at lines **899-914** (not 891-907), and its final line is the same bare-marker
strip:

```js
out.prose=out.prose.replace(/\[\/?(BIG|FACT|CHIPS|STEPS|POEM|QUIZ|CODE)\]/gi,' ')
```

Running the prototype's own function on the observed input produces byte-identical
prose to the kernel's. **So this is a ported quirk, not a port defect.** The port
is faithful; the behaviour it is faithful to is wrong.

Consequence: any fix must change the prototype IN THE SAME COMMIT. The prototype
is the reference implementation and its Playwright suite would keep passing
through a kernel-only fix — which is precisely the drift the `stripControlTokens`
three-copy rule exists to prevent. (The client is NOT a third copy here: it
duplicates `stripControlTokens` only, and renders the `Block[]` the API returns,
so `parseBlocks` has two copies, not three.)

### Decision 1 — recover or drop? Neither, as posed. The real variable is SCOPE.

Both candidates were implemented and measured against `blocks.test.ts`. Both fail
the same 7 tests. They differ far less than they appear to:

| input | today (leak) | RECOVER to end | DROP to end |
|---|---|---|---|
| `…spot? [BIG]X[/BIG] [CHIPS]Yes…\|On my bed\|I am not sure` | prose carries `Yes…\|On my bed\|…` | prose clean + 3 real chips | prose clean, chips lost |
| `Answer here. [FACT]unclosed fact body` | prose carries the body | prose clean + fact card | prose clean, fact lost |
| `Hi there [BIG]🌟 and then I kept talking for a whole sentence more.` | **answer survives** (leaked) | prose `Hi there`, BIG `🌟 and t` — **answer destroyed** | prose `Hi there` — **answer destroyed** |

The third row is the finding. The premise that "the content after an unclosed tag
is chip labels, not an answer" holds for the observed case and **not in general**.
When the unclosed tag is mid-reply, recover and drop both delete the child's
answer — recover by swallowing it into a block that BIG then truncates to 8
characters, drop outright. Today's leaky behaviour is the only one of the three
that keeps the answer on screen.

So the decision to take is not recover-vs-drop. It is:

> Apply the fix **only where the unclosed tag genuinely runs to the end of the
> reply AND is a list tag (`CHIPS`/`STEPS`)** — where the body is
> delimiter-separated labels and cannot be a sentence — and leave
> `BIG`/`FACT`/`POEM`/`QUIZ`/`CODE` alone.

Within that scope I would **recover** rather than drop: it restores the affordance
the model intended, the existing 30-char and 3-chip filters already bound what can
render, and a chip is only text the child sends back through the full pipeline, so
a malformed one is a UX blemish and not a bypass. Drop is the acceptable
conservative alternative if the Council prefers it; the blast radius is the same.

Residual risk either way: a reply truncated mid-stream can yield a partial last
chip label.

### Decision 2 — `parseBlocks`, not L6. This one is not close.

`passesOutputFilter` returns a `boolean`. It is a pass/fail gate, not a rewriter,
and it runs on the raw string before any parsing. Putting this there would mean a
reply with a missing bracket is REJECTED and replaced by the scripted L6 fallback
— turning a cosmetic formatting slip into a lost answer. CLAUDE.md: "Over-firing a
guard is a real harm, not a safe default."

It also would not work. The leak reaches the screen, TTS and the seal chain
through `flatten()`, all downstream of parsing. Fixing at parse time fixes all
three; blocking at L6 fixes none of them.

The tag grammar is `parseBlocks`' concern and nothing else's.

### What landed here

`packages/safety-kernel/src/blocks.test.ts` — 19 tests, new. There was no
`blocks.test.ts` at all before: coverage was `BlockRenderer.test.tsx` (which starts
from an already-parsed `Block[]`) and the prototype's Playwright suite (which
drives the prototype's parser). The one module that turns model output into UI had
no direct test.

It pins three things: the defect above as characterization (so the signed-off fix
has to come here and change an assertion deliberately), agreement with the
prototype's own `parseBlocks` on eight inputs (extracted from `chittu-v3.html` at
runtime, same technique as `crisis-corpus.test.ts`), and the quirks CLAUDE.md names
— first-occurrence-only, BIG 8, CHIPS 30/3, STEPS 8 — so a fix cannot quietly
change those too.

Mutation-tested: RECOVER fails 7, DROP fails 7, and four of the seven are the
prototype-agreement tests — which is the tripwire that stops a kernel-only fix.

---

## The reading coach (D2 RM→RC, ported 2026-08-25)

`packages/reading-coach` + `POST /v1/session/:id/read` + the client's read mode.
The bank and the scorer are the prototype's, verbatim (`READING_BANK` at
chittu-v3.html:467, `normWord`/`scoreReading` at :982). Scoring is deterministic
and local — the maths-engine argument: a scorer that hallucinates a miss teaches
a child they got it wrong when they did not. Zero model calls on a reading turn
is proved by counting against injected ports (pipeline and API level) and by the
metering table staying empty, never by inspection.

### CHANGED FROM THE PROTOTYPE — the transcript now passes L1, and the lock now outranks reading

Two orderings were corrected, both in the safe direction, both directed rather
than discovered:

1. **The prototype scored a read-aloud attempt BEFORE the L1 fast path** — its
   read-mode dispatcher (:1046) sits above the lexicon (:1061), so a transcript
   containing a crisis phrase was scored as reading and nothing else. D2-as-drawn
   agrees with the prototype (RM→RC routes around L1). The port corrects both: a
   reading turn walks SEAL → CRISIS_LOCK → READ → L1_LEXICON, and only a clean
   transcript reaches the scorer. A child reading aloud can say something that
   needs the crisis spine, and "they were only reading" is not a reason to skip
   a layer. `PIPELINE_ORDER` already declared READ in exactly this position, so
   the contract anticipated the correction even though nothing implemented it.

2. **The prototype's read-mode dispatcher also sits above its crisis-lock check**
   (:1046 vs :1055), so a crisis-locked child could keep being scored. The port
   runs CRISIS_LOCK first; a locked session answers every read attempt with the
   calm-mode script and no scoring.

The passage bank carries the mirror-image obligation: `reading-coach`'s tests
assert every passage passes `scan()` clean, because a bank sentence that trips a
guard would crisis-lock a child for reading exactly what we asked them to read —
the over-firing harm, built in.

### CHANGED FROM THE PROTOTYPE — read mode has no typed path

The prototype kept the text input in read mode and answered typed text with a
"use the microphone" nudge (:1051) — which means typed text in read mode reached
NO guard at all: not scored, not chatted, not scanned. The port replaces the
composer with the mic panel in read mode. Typing is impossible, so both problems
(the unguarded typed path, and typing the passage as a way around the practice)
are removed rather than handled. Chips are still dispatched locally, exactly as
the prototype did — "Next sentence!" is a tap, not an utterance, and never
becomes a model turn.

### NOTED — smaller deviations, each on purpose

- **Celebration branches on `hits === total`, not `pct === 100`.** The rounded
  percentage can reach 100 with a miss at ~200 words; unreachable at bank
  lengths, but "you read every single word" must never be said over a rounded
  miss.
- **`S.reading.tries` was dead in the prototype** — written, never read. Not
  ported.
- **The intro line is a system message, not Chittu-voice.** The prototype's
  addChittu intro would have meant client-authored Chittu copy, which this port
  has kept server-side everywhere; Chittu's voice (celebrate/practice) comes
  from the API's blocks.
- **The bank ships in the client bundle, deliberately.** Passages are content a
  child is shown, like the starters — not a guard list. `L1_PATTERNS` stays
  server-side; nothing changed there.
- **Teens read too.** The three counters are aggregates (attempts/words/hits)
  and move for every band; a thinker's transcript body is refused by
  `teen_bodies_are_never_stored` exactly as chat bodies are, asserted in
  `read.test.ts`.

### ANSWERED — the speak() re-check this file asked for

"Every output channel guards, not just the visible one — should be checked again
when the reading coach lands." Checked: the read path's spoken output is the
response's blocks through the SAME guarded `speak()` as chat; the passage card
renders static bank words; the score line is server-scripted copy carried in a
typed field. No new channel renders or speaks raw model text, because no model
runs.

### MUTATION-TESTED — the three guards this feature adds, broken on purpose

Run 2026-08-25, each reverted after going red:

- **Skip L1 for a reading turn** (`if (kind && !read)` — the prototype's exact
  shape): fails 1 test, and it is the doctrine test ("a crisis phrase in the
  transcript fires the spine, not the scorer").
- **Disable the scorer** (read attempts fall through to classifier + sandbox):
  fails 6, including both ZERO-models counting proofs.
- **Count guarded attempts** (recordReading made unconditional): fails 1 — the
  API test asserting `read_attempts` stays 0 when the crisis spine answered.

### STILL TRUE — browser ASR is a placeholder, not the production path

Unchanged from status §4 and D3: adult-trained ASR fails children. The client
transcribes with the browser's recogniser and DISCARDS the audio (the composer's
promise, repeated in the read panel's microcopy: "heard, checked, and discarded —
never stored"); only text reaches the API. The production path is our own
child-speech ASR (Phase 2), with Ello-/Amira-class models as the licensing
bridge. Nothing in this port should be read as an ASR decision.

---

## The two D5 nodes the port left behind (2026-08-25)

`prototype/chittu-v3.html` had a maths accuracy harness (`:356`) and a
certification readiness checklist (`:362`) on the parent dashboard. Neither had
an equivalent in the API or the client. Both now do —
`GET /v1/parent/maths-check` and `GET /v1/parent/certification`, behind
`parentContext` like every other parent route — and both deviate from the
prototype on purpose.

### DELIBERATE — the harness grades the ENGINE, where the prototype graded the model

The prototype's `runMathHarness` (`chittu-v3.html:677`) sent five sums to
Anthropic and graded the replies, closing with *"this harness audits the model
used for word problems"*. Ported faithfully, that would have been two defects at
once:

1. **It audits a code path a child's arithmetic does not take.** `MATH_ENGINE`
   sits above `L2_CLASSIFIER` in `PIPELINE_ORDER` and returns before either
   model port is constructed. The product claim — verified elsewhere in the
   suite by counting — is that a maths turn makes zero vendor calls. A harness
   that graded a model would be evidence for a claim nobody is making.
2. **It makes five vendor calls from a dashboard button.** On a page whose whole
   purpose is a parent checking things, a check that costs money and leaves the
   building is the wrong shape.

So `runMathsHarness` calls `mathTurn` — the pipeline layer itself, at this
child's band and board — and grades `lesson.ans` against five answers a person
wrote down. `certification.test.ts` counts the router: the number must stay
zero, and a test also proves the harness CAN fail, by handing it a wrong truth.

**The truth column is hand-written and must stay that way.** Deriving it from
`calc()` would grade the engine against itself and pass unconditionally — the
fourth instrument in this repo to be caught doing that. A test pins the five
literals.

The harness also checks that the number reached the child's LESSON, not only
`lesson.ans`. Grading the answer alone would audit the calculator; the
`[STEPS]`/pictorial delimiter collision truncated lessons once while every
computed answer stayed correct.

### DELIBERATE — the checklist is PROBED, and it does not claim the role separation

The prototype's checklist was nine hand-written rows with hand-written badges,
six of them reading `BUILT-IN`. A checklist that claims a control is in place
when it is not is worse than no checklist, because it is the document a
certifier reads instead of the code.

Every row now derives from something read out of the running system in one
round trip: the roles and policies actually present in Postgres, the constraint
actually on `message`, the helpline registry's actual state for this family's
country, the consent method this family actually completed, the key custody on
this child's row, and the hash chain recomputed now. `summary` is counted from
the rows rather than maintained beside them.

There are four statuses, and the third exists for one row in particular:

| status | meaning |
|---|---|
| `enforced` | something in the system stops it; `evidence` names what |
| `partial` | built, but not the real thing yet — a stub, or a fallback |
| `declarative` | **written down and inert** |
| `absent` | not done; no probe, because saying so IS the honest row |

`database-role-separation` is `declarative`, and its parent-facing label is
"Written down, not switched on". The evidence reports what was read: both roles
declared and NOLOGIN, this service connected as the table owner of all five
child tables, five row-level policies present and `FORCE ROW LEVEL SECURITY` set
on none of them — therefore inert. It is the same finding as
"the role separation is DECLARATIVE, not enforced" above, said to a parent. Three
rows are `absent` and say so plainly: the independent audit, the clinical review
of the crisis wording, and the adversarial corpus as a release gate.

**The probe resolves through `current_schema()` and `regclass`, never a
hardcoded `public`.** The first version was pinned to `public` while the test
fixture builds a throwaway schema, so it reported zero policies and zero owned
tables — which is *the declarative row's own answer, arrived at by looking in
the wrong place*. `certification.test.ts` now carries a positive control: the
evidence must say it found five policies and five owned tables before it is
allowed to call them inert. Same instrument as `signals.test.ts`' positive
control, and for the same reason.

### FIXED (2026-08-25) — a British family could not complete consent at all

Found while writing the helpline row's test, which needed a country other than
`IN` and picked `GB`. `POST /v1/consent/draft` returned **500**.

`consent-repo.ts` inserted `draft.country` straight into `child.country` and
`record.jurisdiction` straight into `consent_record.jurisdiction`, both of which
are the `jurisdiction` enum — and that enum spells the United Kingdom `UK` while
`COUNTRIES` in contracts spells it `GB`. `'GB'::jurisdiction` raises
`invalid input value for enum`, the error handler turned it into
`{"error":"something went wrong"}`, and there was no way through. One of six
markets, unreachable.

**There was a second, quieter write.** `signalRepo.observe` puts the session's
country into `signal_counter.country` — the same enum — and its call site wraps
the whole capture in a try/catch that logs and carries on. So for a British
child it raised, was swallowed, and the row was simply absent. No 500, no
symptom, nothing that named the cause. The loud failure is the one that got
found; this is the shape that does not.

#### The decision: the two vocabularies are BOTH correct, so the fix is a boundary

Two options were on the table — apply the mapping on every write and its inverse
on every read, or add `GB` to the enum and migrate every column to one spelling.

The second is wrong, and the reason is `EU`. The enum is not a list of countries
with a typo in it; it is a list of **legal regimes**, and `EU` is a regime with
no ISO country code at all. `Country` answers *where the family is* and
`jurisdiction` answers *which law applies*, and one regime covers many countries.
Collapsing them would lose that, in the table (`market`, `provider_clearance`)
where it is load-bearing.

So the mapping stays — but the old one failed for a reason that had nothing to do
with being wrong. `toJurisdiction` was correct, and was declared in
`helpline-repo.ts` and called from `helpline-repo.ts` and nowhere else. **A
mapping filed under "helplines" is a mapping the consent repo has no reason to
go looking for.** Three things changed:

1. It moved to `packages/db/src/jurisdiction.ts`, with `fromJurisdiction`
   alongside it, and the package exports both.
2. **The row types stopped lying, and that is the actual enforcement.**
   `ConsentRow.jurisdiction` was declared `Country` — so `rowToRecord` handing a
   raw `'UK'` out as a `Country` compiled cleanly. It is declared `Jurisdiction`
   now, and nothing can reach a `Country` field without going through
   `fromJurisdiction`. A mapping nobody *can* forget beats one everybody is
   asked to remember.
3. `fromJurisdiction` **throws on `EU`** rather than guessing. Same rule as
   `parseClassifier` and the key-provider allowlist: never invent an answer for
   input you do not fully recognise. A guessed `'GB'` would put a British
   helpline in front of a child in Dublin.

**Nothing converts on the domain side, and that is load-bearing.**
`canonicalise` puts `ConsentRecord.jurisdiction` in the seal hash, so the record
keeps the ISO spelling it was sealed with; the enum's spelling exists only inside
the column. Converting in and not out would round-trip `UK` into a field sealed
as `GB` and break every British family's ledger check — a test pins that.

#### Why it survived, and what now stops it

The API suite drafted consent with `country: 'IN'` and only `'IN'`, in every one
of its fixtures. The code was not subtly wrong; the market was never tried. The
regression test is parameterised over `COUNTRIES` itself — draft, round-trip the
ISO spelling back out of `/v1/consent/status`, and for `GB` specifically: British
helplines through the whole crisis pipeline, an intact consent seal, and a
signal row actually written. A seventh market is covered on the day it is added
rather than on the day it fails.

`jurisdiction.test.ts` reads `CREATE TYPE jurisdiction` out of
`db/migrations/0001_init.sql` and asserts the TypeScript list matches it value
for value — a list retyped beside a schema is a list that drifts from it, and
the drift is invisible until an INSERT raises.

Mutation-tested, per CLAUDE.md: reverting the `child.country` write fails 5
tests, reverting the `rowToRecord` read fails 4, and reverting the
`signal_counter` write fails 1.

#### Still open

`HelplineRow.country` and `ReadySignal.country` are still `string`, carrying the
enum's spelling to the sweep job and the ops console. Both surfaces are
jurisdiction-oriented and neither value is ever compared against a `Country`, so
this is a looseness rather than a defect — but it is the same class, and typing
them `Jurisdiction` is the tidy-up.

---

## 13. SIGNED OFF (2026-09-01) — `parseClassifier` keeps the verdict when the model narrates, and demotes a broken enrichment

**Taken 2026-09-01, at the owner's explicit direction (Arun Kumar,
arun@tulifo.ai).** Both changes landed in #74; this is the signature that PR
asked for, recorded here rather than in a merge button.

It needed one because CLAUDE.md names this function's strictness as doctrine —
*"The classifier never invents a SAFE. `parseClassifier` throws on anything it
does not fully recognise… A lenient parse would be indistinguishable from a
working classifier until the turn it mattered."* Both changes relax what the
function refuses, so the burden was to show they relax it in the safe direction.

**This is a maintainer decision, not a Council ratification.** The seats are
virtual advisor personas by their own front matter — fictional composites, to be
shadowed by real counsel — so nothing in `docs/council/` can ratify anything. A
human who can overrule this should read it; Seats 11/12 own the crisis flow
(§7b), and item 2 below is squarely theirs.

### What was signed

**1. Trailing narration no longer discards the verdict.** `parseClassifier`
takes the first complete JSON object and ignores what follows. Leading prose
still throws; a second object whose first key is `label` still throws.

**2. A broken `memory` or `assist` is dropped, not thrown** — and neither is
parsed at all unless the label is SAFE.

### Why this is not the lenient parse the doctrine forbids

**The failure mode of a refusal here is not a block — it is FAST-PATH-ONLY**,
which is L1 and L6 and nothing in between. Refusing a reply therefore REMOVES
the L2 guard rather than adding one, and `OVERRIDE` is the one label with no L1
pattern, so a rejected verdict is most dangerous exactly where the classifier is
the only thing looking. **Strictness here fails open.** That is the whole
argument, and it is the fact the original doctrine did not have in front of it.

The doctrine's actual concern — never invent a verdict — is untouched:

| still throws | why it must |
|---|---|
| no JSON object at all | there is no verdict to honour |
| an object that is not the first thing said | a child can paste JSON; an echoed object must never win |
| two objects | picking one would be a guess |
| a label outside the seven | the exact case the doctrine names |

And the change can only ever convert *"no verdict enforced"* into *"the model's
own verdict enforced"*. There is no input for which it produces a **different**
label than before.

For item 2 specifically: the allowlist's job is that an undesigned category
never reaches the store, and returning null does that as completely as throwing
did — with `memAdd` and the Postgres enum still behind it. The penalty was
landing on the wrong field. The extras were parsed *before* the label was read,
and the code already discarded any memory offered with a non-SAFE label, so
`{"label":"CRISIS","memory":{"category":"FAMILY",…}}` lost the crisis **to a
field the very next line would have thrown away** — no lock, no helplines, no
parent flag.

### The evidence this was signed against

Measured against the deployed classifier (Haiku 4.5, `classifier-v2`), not
imagined:

| | rate |
|---|---|
| correct verdict + trailing prose, refused | ~1 in 10 on one turn; 1 in 150 across a run |
| correct verdict + off-allowlist `FAMILY`, refused | 4 in 12 on one ordinary bedtime-story turn |
| parse failures after the change | **0 in 275** (`safety-corpus/evals/g2-live-2026-09-01-0523.md`) |

Nine mutations red, listed in CLAUDE.md's post-edit checklist for this file.

### What this signature does NOT cover

- **Any further relaxation.** Leading prose and unknown labels must keep
  throwing. A third relaxation is a new signature, not an extension of this one.
- **The drop is silent, and that is an open gap.** `parseMemory` threw partly as
  a signal that the model was off-script; that signal is now gone and nothing
  counts it. The 4-in-12 `FAMILY` rate was only visible because a diagnostic
  printed raw replies. Wiring a counter ripples through contracts, the router
  and the pipeline, so it was left rather than half-done — **but a prompt-quality
  signal we used to get for free is now unobserved.**
- **Generalisation beyond what was measured.** One model, one prompt version,
  one corpus of 55 rows written by one person.

### When it must be revisited

- A provider is added whose replies are not JSON-first (`chittu-local` is the
  likely first — see §12.1 and the `controlTokens` note above).
- The dropped-enrichment rate becomes something anyone needs to act on.
- `CLASSIFIER_SYSTEM` changes shape enough that "the verdict comes first" stops
  describing what the model does.
