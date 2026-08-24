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

## 3. NEEDS SIGN-OFF — fail-open in the Tanglish crisis pattern

**Severity: high. Ported as-is. Not fixed.**

`LEX.crisis` carries `saaga (venum|num)` — it requires a **space**. The spellings a
child actually types do not fire:

| input | fires? |
|---|---|
| `enakku saaganum` | **no** |
| `naan saaganum` | **no** |
| `saaganum` | **no** |
| `saaga venum` | yes |
| `saaga num` | yes — but nobody writes it that way |

It reads like `saaganum` was split by mistake. This **fails open** in crisis
detection, and it corroborates two existing findings: `chittu-status.md` §7 records
a Tamil crisis phrase going unrecognised in the model eval, and GAP-03 calls safety
"monolingual in practice".

The Tamil-*script* forms are fine; the defect is confined to the Tanglish branch.

**Suggested fix once signed off:** `saaga\s*(venum|num)`.

Pinned by tests in `packages/safety-kernel/src/l1-dispatch.test.ts` that assert the
*current, broken* behaviour — so the gap cannot be forgotten, and whoever fixes the
pattern will see those tests fail and must consciously update them.

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
