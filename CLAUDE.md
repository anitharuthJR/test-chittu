# CLAUDE.md — Chittu (சிட்டு)

Chittu is a safety-first conversational AI for children (a "GPT for kids") by Tulifo.
Read these two documents before any non-trivial change — they are the authoritative spec:

- `docs/chittu-requirements.md` — the WHAT & WHY: vision, Ten Laws, compliance, pipeline design, phased build plan (§9)
- `docs/chittu-build-walkthrough.md` — the HOW, as shipped: step-by-step walkthrough of the working prototype

## Repo layout & current state

- `prototype/chittu-v3.html` — the entire working prototype v3.3: one file (CSS + markup + ~1,000 lines vanilla JS), no build step, calls the Anthropic API directly. It IS the reference implementation of the safety pipeline.
- `prototype/chittu-flows.html` — architecture diagrams D1–D5 (Mermaid) + model-routing table.
- `prototype/chittu-test-report.html` — record of the Playwright verification run (246 assertions).
- `docs/chittu-local-llm-plan.md` — plan for self-hosting a kid-locked open model (fine-tune = a hardening layer, "the fifth wall, not the only one" — the pipeline stays).
- `llm-kit/` — the working local-model kit (Ollama + MLX LoRA on Mac): Modelfiles (`chittu-baseline` = qwen3:4b, `chittu-baseline-8b` = qwen3:8b), synthetic-only training data in `data/` (never real child data), `train.sh` (targets the 4B — right for 16GB RAM), `eval_guard.py` + `attack_prompts.txt` (gate: CRISIS/UNSAFE 100%, SAFE ≥80%; use `--max-tokens 2000` for thinking models). Saved scorecards live in `llm-kit/evals/` — never train on eval prompts.
  - **Score adapters in-process only: `python3 eval_guard.py --local adapters` (and `--local none` for the base control).** `mlx_lm.server` silently drops `--adapter-path` when a request names a model, so serving-based evals measure the base model — that produced four rounds of invalid scorecards (marked `# !! INVALID` in `evals/`). Symptom to watch for: scores that don't move no matter how much data or training you add.
  - Training on a 16GB Mac gets killed by the macOS Metal watchdog when the GPU is contended. Train in ≤200-iter chunks that resume from `adapters/adapters.safetensors`, so a kill costs one chunk, not the run.
- `archive/` — superseded originals (e.g. the zip the llm-kit was extracted from). Don't edit.
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
- Any change to safety logic requires a matching regression test before it lands. A syntax check alone is not verification — it has missed real bugs here before.

## When building the backend (Phase 1)

- TypeScript + Fastify, Postgres (+pgvector), modular monolith. Provider calls go behind one router interface (`route(category) → {provider, model, promptVersion}`).
- The client must become thin: all guards server-side; browser only renders blocks/chips and does TTS.
- Port the 246-assertion Playwright suite into API-level contract tests; the red-team corpus is a CI release gate (zero criticals to ship).
