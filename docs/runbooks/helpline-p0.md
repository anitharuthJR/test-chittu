# Runbook — helpline registry

**Owner:** Seat 12 (clinical) with ops on call · **Gate:** G3

These numbers are read to a child in distress. That makes this the one dataset
where being *out of date* is itself a safety failure: a number that quietly
stopped working is worse than one never offered, because the child dials it and
nobody answers.

---

## What the system does on its own

An hourly sweep (`apps/api/src/helplines/sweep.ts`) checks `next_sweep` on every
row. **It does not dial anything** — no API tells you whether a national child
helpline still answers. It notices that a re-check date has passed, moves the
row to `stale`, and pages you.

**You are the verification.** The software's job is to make sure nobody forgets
to be one.

## The three states, and what a child gets in each

| State | What a child in crisis sees | Urgency |
|---|---|---|
| `verified` | the registry's numbers | — |
| `stale` | **the registry's numbers, unchanged** | this week |
| `P0_WRONG_NUMBER` | the shipped fallback numbers | **now** |

**`stale` deliberately changes nothing a child sees.** Overdue is not wrong.
Withholding a probably-correct helpline because *our* re-check date slipped
would punish the child for our process failure, and a missing number is worse
than an unverified one.

`P0_WRONG_NUMBER` is the only state that edits the script, because a number
known to be wrong is worse than no number at all.

---

## WARN — "re-check was due"

You have days, not minutes. Children are still being given these numbers, and
they are probably still right.

1. **Check each line actually answers.** Call it. Yes, really — it is two
   minutes and it is the entire control.
2. Check the operator's own site for changed hours, a renamed service, or a
   number that now redirects.
3. If the numbers are good:
   ```bash
   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts verify IN you@tulifo.ai 30
   ```
4. If a number has changed, update the lines and verify in the same step. If a
   number is *wrong*, go to P0 below first.

## P0 — a number is wrong

A child may be dialling a dead or incorrect line **right now**. Minutes matter.

1. **Flag it immediately.** This switches that market to the shipped fallback
   numbers on the very next turn — no deploy, no restart:
   ```bash
   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts p0 IN you@tulifo.ai
   ```
2. Confirm the fallback is sane for that market:
   `GET /v1/helplines/IN` should report `"source": "builtin"`.
3. Find the correct number with the operator directly, not from a search result.
4. Load it and verify:
   ```bash
   pnpm --filter @chittu/api exec tsx src/helplines/cli.ts verify IN you@tulifo.ai 30
   ```
5. **Write down how long children had the wrong number**, and whether any crisis
   turn occurred in that window. Sessions are sealed; the audit chain can answer
   it. This goes in the incident record and, if a child was affected, into the
   DPIA's breach assessment.

## The registry is empty

Every market silently runs on the shipped fallback — which works, and is exactly
why nobody notices. `list` says so plainly:

```bash
pnpm --filter @chittu/api exec tsx src/helplines/cli.ts list
pnpm --filter @chittu/api exec tsx src/helplines/cli.ts import   # imports UNVERIFIED
```

`import` copies the compiled-in numbers in with `next_sweep = now()`, so the
next sweep marks them stale and pages you. **Importing is not verifying** — the
rows say `import:builtin (UNVERIFIED)` until a human has called each line.

---

## What is not wired yet

- **Alerts go to the log, not to a pager.** `AlertPort` in `sweep.ts` is the
  seam; PagerDuty is a construction change, not a rewrite. Until then, someone
  must be reading logs, and that is a weaker guarantee than this gate needs.
- **The sweep runs in-process on a timer.** A job that runs only while one API
  process is up is a job that stops when that process does. The production shape
  is a scheduled task (architecture §14).
- **Nothing verifies automatically**, and nothing can. See the top of this file.

Both of the first two are G3 blockers. They are named here rather than in a
ticket because this is the page someone will be reading when it matters.
