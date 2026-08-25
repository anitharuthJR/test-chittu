# Didit ID verification for parents — design

**Date:** 2026-08-25
**Status:** approved, ready to implement
**Gate:** G1 (verifiable parental consent) — currently 🔴 *mocked, blocks launch*; only `dev_stub` completes.

## Problem

`packages/consent` defines a `ConsentAdapter` port with six methods declared and
exactly two implemented: `dev_stub` (non-production) and `signed_form_review`
(a human ops process). Every other rail is blocked on something this repo cannot
conjure — a payment integration, a commercial agreement, a legal review. G1 is
the longest-lead launch blocker as a direct result.

Didit is an identity-verification vendor with a hosted capture flow. Adding it as
an adapter makes Chittu's first *automated* consent rail real.

## What Didit gives us

- `POST https://verification.didit.me/v3/session/` (`x-api-key`) with
  `workflow_id`, `vendor_data`, `callback` → `{ session_id, url }`. The parent
  completes ID capture, liveness and face match on Didit's hosted page.
- `GET https://verification.didit.me/v3/session/{session_id}/decision/`
  (`x-api-key`, needs `read:sessions`) → `status` plus a decision object.
- Statuses: `Not Started`, `In Progress`, `Awaiting User`, `In Review`,
  `Approved`, `Declined`, `Resubmitted`, `Expired`, `Kyc Expired`, `Abandoned`.
- Free workflows are rate-limited to 10 session creations per minute.

The decision object is a firehose of PII: `full_name`, `date_of_birth`,
`document_number`, `portrait_image`, `front_image`, `back_image`, `mrz`,
`nationality`, `gender`, `address`, `place_of_birth`, face-match and liveness
scores. The adapter contract is the opposite of that — **a reference and a hash,
never the evidence** — so the boundary between those two facts is the whole
design.

## Decisions taken

| Question | Decision |
|---|---|
| Which adult surface | Parental consent at signup (the G1 rail), not the parent PIN gate |
| What counts as verified | `Approved` **and** document holder is 18+ **and** the name matches |
| Match scope | Parent types their **full** legal name; only the **first** name is persisted, as today |
| Mismatch handling | Normalise hard → bounded retry (≤3, same Didit session) → fall back to `signed_form_review` |
| Verdict path | Server-side poll on `finalize`. Webhook deferred, port left shaped for it |
| Enum value | New vendor-neutral `automated_id_check`, with `provider = 'didit'` |
| Availability | Self-gating on config: offered only when `DIDIT_API_KEY` + `DIDIT_WORKFLOW_ID` are set |

`gov_id_review` keeps its current meaning — a *human* review of a voluntarily
provided ID — and stays unimplemented. Naming the new value for the vendor was
rejected: `consent_verification.provider` already carries that, and a vendor name
baked into a database enum makes a provider switch a migration.

## Architecture

New unit `packages/consent/src/didit/`, three files with one job each:

| File | Responsibility | Depends on |
|---|---|---|
| `client.ts` | HTTP only: `createSession()`, `fetchDecision()`. Owns endpoints, auth, timeouts, and **narrowing**. | `fetch` |
| `name-match.ts` | Pure. Normalise and compare two names. No I/O, no vendor types. | nothing |
| `adapter.ts` | The `ConsentAdapter`. Orchestrates the two above. | both |

`name-match.ts` is separate because it holds the interesting logic and the most
test cases, and it must be testable without a network or a vendor type in sight.

### Flow

```
1. Parent completes the seven form steps, picks "Photo ID check"
2. POST /v1/consent/draft
     adapter.start()  ->  POST /v3/session/
                          { workflow_id, vendor_data: <challengeId>, callback }
                      <-  { session_id, url }
     store draft, status = 'verifying'
   <- 201 { consentId, challengeId, redirectUrl }        <-- NEW field
3. Client sends the parent to redirectUrl (Didit-hosted capture)
4. Didit redirects the parent back to our callback
5. POST /v1/consent/:id/finalize { challengeId, proof: { fullName } }
     adapter.complete()
        -> GET /v3/session/{id}/decision/        (server-side, authoritative)
        |- status !== 'Approved'   -> not verified
        |- age < 18                -> not verified
        |- name mismatch           -> retryable, attempt n of 3
        \- all three pass          -> VerificationEvidence
   <- consent cookie set, ledger returned
```

The verdict is **never** taken from the client. `proof` carries only the name the
parent typed; the status comes from Didit's API over our own connection.

### Port changes (both additive)

1. `VerificationChallenge` gains optional `redirectUrl?: string`. Existing
   adapters do not set it; the client renders the hand-off only when present.
2. `ConsentAdapterError` gains `code: string` and `retryable: boolean`, so
   `finalize` can answer `422 { error, code, retryable }` and the client can tell
   "try again" from "this rail is over".

A discriminated-union return from `complete()` was considered and rejected: it is
the more honest type, but it changes the signature of all six existing adapters
for one adapter's benefit. `In Review` and a name mismatch are carried as
retryable errors instead.

3. `AdapterRegistryOptions` gains `didit?: { apiKey, workflowId, baseUrl, callbackUrl }`,
   so `available` self-gates and `offersFor` filters the method out when
   credentials are absent.

### Schema

`db/migrations/0008_automated_id_check.sql`, mirrored into `docs/chittu-schema.sql`:

- `ALTER TYPE consent_method ADD VALUE 'automated_id_check'`
- `ALTER TABLE consent_record ADD COLUMN verify_attempts smallint NOT NULL DEFAULT 0`
  with `CHECK (verify_attempts >= 0)`

The attempt counter is server-side because a client-supplied counter is not a
bound.

## Name matching

Normalise: NFKD → strip combining marks → lowercase → punctuation to space →
collapse whitespace → drop honorifics (`mr, mrs, ms, miss, dr, prof, shri, sri,
smt, thiru, thirumathi, selvi, mx`) → tokenise.

`md` is deliberately **not** treated as an honorific — in South Asia it
abbreviates Mohammad, a given name.

Match, order-insensitive:

- A typed token matches a Didit token if they are **equal**, or **one is a single
  letter equal to the other's first letter**.
- Every token in the **shorter** list must find a match, **and** at least one
  match must be between two full words (2+ characters).

The second clause is the anti-wildcard guard: without it, typing `K` alone
matches `KARTHIK RAJENDRAN` through initial expansion.

| Typed | On ID | Result |
|---|---|---|
| `R. Karthik` | `KARTHIK RAJENDRAN` | pass — `r`→`rajendran`, `karthik`→`karthik` |
| `Karthik R` | `KARTHIK RAJENDRAN` | pass — order-insensitive |
| `Karthik` | `KARTHIK RAJENDRAN` | pass — subset |
| `José Álvarez` | `JOSE ALVAREZ` | pass — diacritics folded |
| `Priya Sharma` (married) | `PRIYA KRISHNAN` | fail → retry, then fallback |
| `Krishna` | `KRISHNAN` | fail → retry (transliteration is not fuzzy-matched) |
| `K` | `KARTHIK RAJENDRAN` | fail — anti-wildcard |

Fuzzy similarity with a numeric threshold was rejected: a tuned cutoff on a
launch-blocking legal gate is hard to defend to a regulator. Retry plus the
human fallback absorbs transliteration variance instead.

Indian naming conventions drive these rules. Parents in Tamil Nadu write
`R. Karthik` or `Karthik R` where the passport reads `KARTHIK RAJENDRAN`; an
exact-match rule would reject a large share of legitimate parents on the one
gate that blocks launch.

## The PII firewall

`client.ts` narrows at the boundary. `fetchDecision()` parses the response and
returns only:

```ts
{ status: DiditStatus, isAdult: boolean, name: { full, first, last } }
```

The raw decision object is never returned, logged, or stored. Consequences:

- **`isAdult` is computed inside `client.ts`**, so `date_of_birth` never leaves
  that module and `adapter.ts` cannot see a DOB even by accident.
- `document_number`, `mrz`, `nationality`, `gender`, `address`,
  `place_of_birth`, face-match and liveness scores are never read at all.
- `portrait_image` / `front_image` / `back_image` are presigned URLs and are
  **never fetched**. A test asserts the client issues requests to exactly the two
  known endpoints and nothing else.
- `vendor_data` carries the random `challengeId` only — never a parent email,
  never the child's name. It travels to a third party and returns in webhook
  payloads.
- Stored evidence is `providerRef = session_id` and
  `hashEvidence({ session_id, status, workflow_id, adult, matched })`. **The name
  is deliberately not a hash input** — a stored hash of a name is a guessing
  oracle.
- `SENSITIVE_PATHS` in `apps/api/src/logging.ts` gains the Didit field names.

Two boot-time guards, mirroring `reject_dev_stub_in_prod`: a sandbox Didit
environment configured under `NODE_ENV=production` refuses at startup, and the
method is filtered out of `offersFor` when credentials are absent.

## Status mapping

| Didit `status` | Outcome | Retryable | Parent sees |
|---|---|---|---|
| `Approved` + adult + name match | **verified** | — | proceeds to chat |
| `Approved` + adult + name mismatch | fail | yes (≤3) | "check the name matches your ID" |
| `Approved`, under 18 | fail | no | routed to `signed_form_review` |
| `Declined` | fail | no | routed to `signed_form_review` |
| `In Review` | pending | yes | "still checking — come back" |
| `Not Started` / `In Progress` / `Awaiting User` / `Resubmitted` | pending | yes | "finish the check" |
| `Expired` / `Kyc Expired` / `Abandoned` | fail | no | start again |
| network error / timeout | fail | yes | try again |
| **unrecognised status string** | fail | **no** | — |

The last row is `parseClassifier`'s rule applied here: **never invent a safe
answer for input you do not fully recognise.** An unknown status must never fall
through to approved.

## Verification

- `name-match.test.ts` against a corpus of names **as parents actually write
  them**, not derived from the normaliser. CLAUDE.md is explicit that a corpus
  read off the pattern it tests is testing itself; three instruments in this repo
  have already been caught doing exactly that.
- `adapter.test.ts` with stubbed fetch — one case per status row above.
- Mutation tests, because a guard whose removal is silent is not a guard.
  Removing the `Approved` check, the adult check, the name check, or the attempt
  bound, or defaulting an unknown status to approved, must each turn tests red.
- `db/schema.test.ts` gains the enum-value and `verify_attempts` invariants, in
  its existing "try to violate it and assert the database refuses" style.
- `pnpm verify` before merge — GitHub Actions was removed, so nothing else will.

## Open, and not closeable in code

1. **DPO/DPIA sign-off.** A processor now handles parents' biometrics. Building
   the adapter does not clear that; config-gating is what keeps the claim honest.
2. **Didit's retention policy** is what satisfies COPPA §312.5(b)'s condition
   that the ID be deleted promptly after matching, since we never hold it.
   Someone has to read their DPA.
3. **A Didit workflow** with ID + liveness + face match must exist; the build
   targets sandbox until a `workflow_id` is supplied.
4. Free-tier rate limit: 10 session creations per minute.
