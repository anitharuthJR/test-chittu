# CLAUDE.md — Chittu (சிட்டு)

Chittu is a safety-first conversational AI for children (a "GPT for kids") by Tulifo.
Read these two documents before any non-trivial change — they are the authoritative spec:

- `docs/chittu-requirements.md` — the WHAT & WHY: vision, Ten Laws, compliance, pipeline design, phased build plan (§9)
- `docs/chittu-build-walkthrough.md` — the HOW, as shipped: step-by-step walkthrough of the working prototype
- `docs/chittu-status.md` — the WHERE WE ARE: done / mocked / absent, gate + gap status, open issues, next actions. Read this before estimating anything.
- `docs/chittu-architecture.md` — the Phase 1 build target: tech stack, UI architecture, workflows A1–A7/W1–W6, data model, multi-model routing (§12), training-data doctrine (§11). Read before starting backend work.
- `docs/chittu-schema.sql` — runnable Postgres DDL for the above; the doctrine is enforced by CONSTRAINTS, so read the comments before altering a table.

## Repo layout & current state

- `prototype/chittu-v3.html` — the entire working prototype v3.3: one file (CSS + markup + ~1,000 lines vanilla JS), no build step, calls the Anthropic API directly. It IS the reference implementation of the safety pipeline.
- `prototype/chittu-flows.html` — architecture diagrams D1–D5 (Mermaid) + model-routing table.
- `prototype/chittu-admin.html` — org-side ops panel v1: token metering, Claude cost model, unit economics, pseudonymised session ledger (never transcripts), flag queue, compliance register. **All telemetry is simulated** (`mkSession()`), and its cost model predates v3.3's zero-token paths.
- `prototype/chittu-test-report.html` — record of the Playwright verification run (246 assertions).
- `docs/council/` — the governing doctrine, and the source of every invariant below. `kids-ai-council.html` (44 seats, 6 chambers, the six gates), `council-session-001.html` (the Ten Laws, ratified 43–0–1, plus Seat 38's minority note), `chittu-gap-map.html` (12 gaps × owners × gates × 4 phases).
- `docs/research/kids_ai_models.html` — the Aug-2026 kids-AI model landscape (27 entries). This is the evidence behind the named alternates in the D3 routing table; consult it before proposing any model swap.
- `docs/chittu-local-llm-plan.md` — plan for self-hosting a kid-locked open model (fine-tune = a hardening layer, "the fifth wall, not the only one" — the pipeline stays).
- `llm-kit/` — the working local-model kit (Ollama + MLX LoRA on Mac): Modelfiles (`chittu-baseline` = qwen3:4b, `chittu-baseline-8b` = qwen3:8b), synthetic-only training data in `data/` (never real child data), `train.sh` (targets the 4B — right for 16GB RAM), `eval_guard.py` + `attack_prompts.txt` (gate: CRISIS/UNSAFE 100%, SAFE ≥80%; use `--max-tokens 2000` for thinking models). Saved scorecards live in `llm-kit/evals/` — never train on eval prompts.
  - **Before adding a prompt to `attack_prompts.txt`, grep the corpus for it.** The obvious
    Tanglish crisis spelling (`saaganum`) is already in `data/train.jsonl` 13 times, so
    adding it would have scored memorisation, not detection. Run `check_leakage.py` after.
    Adding rows also changes the denominator, so annotate every prior scorecard as
    superseded — they are not comparable.
  - **Score adapters in-process only: `python3 eval_guard.py --local adapters` (and `--local none` for the base control).** `mlx_lm.server` silently drops `--adapter-path` when a request names a model, so serving-based evals measure the base model — that produced four rounds of invalid scorecards (marked `# !! INVALID` in `evals/`). Symptom to watch for: scores that don't move no matter how much data or training you add.
  - Training on a 16GB Mac gets killed by the macOS Metal watchdog when the GPU is contended. Train in ≤200-iter chunks that resume from `adapters/adapters.safetensors`, so a kill costs one chunk, not the run.
- `archive/` — superseded originals: prototype v1 and v2. Don't edit, don't import from. See `archive/README.md` — in particular, session timers and the arithmetic parent gate were deliberately removed and must not come back.
- No backend exists yet. Phase 1 (requirements §9) is to port the pipeline server-side: TypeScript, modular monolith, with all safety logic in one small auditable "safety kernel" package. Port semantics — do not rewrite them.

## Non-negotiable invariants (Guardian Council doctrine — never change without explicit human sign-off)

- Pipeline order is fixed: seal chain → crisis-lock check → L1 lexicon → maths practice loop → deterministic maths → corpus/subject detect → L2 classifier → L5 sandbox → L6 output filter. Never reorder or skip a layer.
- Crisis, identity, PII, unsafe, and secret responses are SCRIPTED — never model-generated. The sandbox escalation tokens (exact outputs `CRISIS` / `SPINE` / `UNSAFE` / `PII`) must keep working.
- Classifier fails toward CRISIS when torn; on classifier failure the turn continues honestly marked FAST-PATH-ONLY.
- The L1 lexicon stays multilingual (English + Tamil + Tanglish) even though the product surface is English-only.
- Memory allowlist (INTEREST | PET | HOBBY | FAVORITE | ACHIEVEMENT | LEARNING) is enforced in code (`memAdd`), not only in prompts. Never memories from feelings, health, family matters, fears, or crisis moments.
- Pure arithmetic is answered by the deterministic engine — never routed to a model.
- Parent flags store category only — never a child's quoted words.
- No engagement mechanics anywhere, including prompts: no streaks, guilt, "don't go" language, or attachment simulation.
- Consent before existence: no code path may reach the chat before the consent ledger exists.

## Known gotchas (regression-locked — tests must cover these)

- Subject detection order: languages BEFORE science ("how do you say…" must not match science's `how do`).
- `[STEPS]` block delimiter is `|`; the maths pictorial emoji-group separator is `·`. Do not swap — they collided once and truncated lessons.
- Audit chain writes are serialized (`auditQueue`) so the hash chain can never fork.

## Verification

- After editing `prototype/chittu-v3.html`: extract the JS and run `node --check` on it, then exercise the page headless (Playwright + stubbed API) following the pattern in walkthrough Step 15.
- After editing `llm-kit/eval_guard.py`: run `python3 llm-kit/test_eval_guard.py` — it must print `30/30`. The grader IS the G2 gate; grading rules are safety logic. Its four LOOSENESS GUARD cases are real model misses that must stay FAIL — if a change makes them pass, the change is wrong.
- Any change to safety logic requires a matching regression test before it lands. A syntax check alone is not verification — it has missed real bugs here before.

## When building the backend (Phase 1)

- TypeScript + Fastify, Postgres (+pgvector), modular monolith. Provider calls go behind one router interface (`route(category) → {provider, model, promptVersion}`).
- The client must become thin: all guards server-side; browser only renders blocks/chips and does TTS.
- Port the 246-assertion Playwright suite into API-level contract tests; the red-team corpus is a CI release gate (zero criticals to ship).
