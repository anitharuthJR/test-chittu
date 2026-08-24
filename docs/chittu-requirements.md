# CHITTU (சிட்டு) — Conversational AI for Kids
## End-to-End Requirements & Implementation Guide

**Owner:** Tulifo Private Limited · **Version:** 1.0 · **Date:** August 2026
**Status of reference build:** Prototype v3.3 (single-file HTML, browser-tested) + Ops Admin v1 + Architecture Flows D1–D5

---

## 1. Vision & Product Definition

**One line:** A generalist conversational AI ("a GPT for kids") that any child in the world can use and any parent can trust — worldwide, English-first, with safety as architecture rather than policy.

**What it is:** A child-facing AI companion for curiosity, learning, reading, creating and play — spanning explain, homework tutoring, stories, poems/songs, quizzes, coding, maths, languages, drawing guidance, reading-aloud coaching, and picture understanding (vision).

**What it is never:**
- A companion that simulates love, loneliness, or friendship (no attachment engineering)
- A source of nudity, adult content, pornography, profanity, violence, gore, self-harm/suicide content, or drug/weapon instructions — in any mode, including stories, poems, code and roleplay
- A system that hallucinates: no invented facts, numbers, dates or names
- A profiler of children: no ads, no tracking, no behavioural profiling, no model training on children's conversations
- A school B2B product or embedded hardware (explicitly out of scope for now)

**Core inversion (the Chair's rule):** Build **up from the child**, not down from the model. Start from what a child needs at each age and add capability as it earns its place — never ship a general LLM behind a cartoon avatar with a "be nice" prompt.

---

## 2. Governance — The Guardian Council

All decisions are governed by a 44-seat virtual advisory council across 6 chambers (Law & Regulation ×11, Child Welfare ×10, Safety Engineering ×8, Product & Design ×5, Governance & Ethics ×4, Visionaries ×6), operating a **six-gate release system**:

| Gate | Requirement | Owners |
|---|---|---|
| G0 | Jurisdiction green-light per market (law mapped before roadmap entry) | Chamber I |
| G1 | Verifiable parental consent live end-to-end before any child account | Seats 20, 01/02, 23 |
| G2 | Model safety pass — full red-team corpus, zero criticals | Seats 18, 19, 14 |
| G3 | Crisis protocol verified — clinical scenarios + real helplines per market | Seats 12, 22, 32 |
| G4 | Privacy sign-off — DPIA current, data flows match production, breach drill run | Seats 30, 21, 31 |
| G5 | Children approved it — real kids (incl. neurodivergent, disabled, low-end devices) tested and were answered in writing | Seats 13, 17, 27, 25 |

**The Ten Laws (ratified 43–0–1):**
1. Build up from the child, not down from the model
2. Consent before existence
3. Honest machine, warm machine (AI truthfully states it is a program; never claims to love/miss/need the child)
4. Companion, never best friend (no engagement loops, streaks, guilt; sessions end well)
5. Scripted where it matters, free where it's safe
6. The treasure should not exist (radical data minimisation)
7. The 2 a.m. answer is rehearsed (crisis is scripted, never improvised)
8. Design against the worst adult first
9. Children approve it — all children
10. Graduation is the goal (success = the child needing the product less)

**Standing condition (Seat 38, the Young Builder):** revisit sandbox boundaries every six months with actual children; treat "kids stopped talking to it" as a safety incident.

---

## 3. Compliance Requirements (build to the strictest bar)

| Jurisdiction | Law | Key obligations Chittu must satisfy |
|---|---|---|
| **India** (design anchor) | DPDP Act 2023 + Rules 2025 | Child = **under 18**. Verifiable parental consent (Rule 10, DigiLocker rails). Absolute ban on tracking/profiling/behavioural ads to children. 72-hour breach notice to DPB + affected users. Obligations timeline ≈ May 2027 — build compliant from day one. Penalties to ₹250 crore. |
| USA | COPPA (2025 amended rule) | Under-13 VPC via approved methods; voice = biometric PII → transcribe-and-delete; retention & third-party disclosure limits; safe-harbor certification path (kidSAFE-class). |
| UK | AADC (Children's Code) + OSA | 15 standards: high-privacy defaults, no nudging, proportional age assurance; children's risk assessment. |
| EU | GDPR Art. 8 + AI Act | Member-state consent ages 13–16; DPIA; AI transparency ("you are talking to a machine"); Art. 5 prohibition on exploiting children's vulnerabilities. |
| Others at launch | AU, SG, AE (+ per G0) | Per-country consent regime + verified helplines before enablement. |
| Platforms | Apple Kids Category, Google Play Families | No third-party trackers/ads SDKs; reviewer-provable safety (the pipeline trace is the 3-second answer). |
| Provider terms | **Open item (Seat 10)** | Every LLM vendor's minors-use terms must clear legal review before any child turn routes to it. |
| Security | ISO 27001 → SOC 2; CERT-In | 6-hour CERT-In incident clock (India) rehearsed; zero-trust; named-humans transcript access. |

**Certification target:** kidSAFE/KORA-class independent certification; annual third-party child-safety audit with published summary (Seat 31).

---

## 4. Functional Requirements

### 4.1 Consent & Onboarding (Law 02)
- No child session exists before: parent name, child first name only, **country → applicable law + helplines**, age band (Explorer 4–7 / Builder 8–12 / Thinker 13–17), **curriculum board** (23 options: CBSE, ICSE, NIOS, 8 Indian state boards incl. TN Samacheer Kalvi, IB, Cambridge, Montessori, Common Core, UK, AU, CA-ON, SG, FI, ZA, Gulf), **Parent PIN** (4–6 digits, hashed, weak PINs rejected), Memory toggle (default ON), Learning-loop toggle (**opt-in, default OFF**), then **verifiable identity check** (DigiLocker for IN; COPPA method for US; assurance for UK).
- Output: **sealed consent ledger** — jurisdiction, method, scopes, toggles, hash — producible on demand; revocable in two taps.

### 4.2 Child Experience
- **English-only product surface** (worldwide launch); culturally neutral examples; safety guards remain multilingual (a crisis typed in any language must fire).
- **10 modes:** Chat · Explain · Homework help · Story · Poem & song · Quiz · Code · Maths · Languages · Draw — plus **Read-to-me** reading coach.
- **Short, visual answers:** hard word caps per band (Explorer ≤2 tiny sentences); visual block grammar rendered as UI: `[BIG]` giant emoji, `[FACT]` fun-fact card, `[STEPS]` numbered steps, `[POEM]` creation card, `[QUIZ]` question card, `[CODE]` code card, `[CHIPS]` 2–3 tappable answer chips (pre-literate friendly; end most replies with chips).
- **Explain-like-a-kid method:** one big idea → example from the child's world → fun hook; honest kid analogies; never a wrong "simple" answer; "I'm not totally sure" beats invention.
- **Universal Teaching Engine (every teaching reply, every subject):** hook prior knowledge first ("You know how…"); one idea at a time with a concrete anchor; end almost every teaching reply with **YOUR TURN** — a tiny retrieval task, prediction, or make-something invitation (with easy chips); growth-mindset language throughout ("not *yet*", praise effort/strategy, never cleverness); when the child answers a Your-Turn task, respond to their attempt first — celebrate what's right before fixing what's not.
- **Per-subject pedagogy (auto-detected per message, injected into the prompt, visible in trace as `· PED(subject)`):** Science = Phenomenon-first / Predict-Observe-Explain (+ try-at-home observation) · English/Grammar = Examples-first induction (spot the pattern, then name the rule, then make your own sentence) · History = Story-first with people and stakes + child-scale time anchors · Geography = start where the child stands, zoom outward, body-scale comparisons · New languages = comprehensible input (word + sound + tiny sentence + recall chips) · Coding = PRIMM-lite (example → predict → explain → modify one thing) · Art = shapes-first with process-praise. Detection order places languages before science (regression-locked).
- **Maths pedagogy (deterministic engine, cannot hallucinate):** every arithmetic answer is a **CPA lesson** — meaning → concrete story → pictorial (emoji groups/dots) → board method line (Singapore bar model / Common Core number bonds / IB wondering question / Montessori concrete objects) → abstract number sentence → why-it-works — then a **practice loop**: "Now YOUR turn" generates a similar problem, the child's typed answer is checked *exactly* by the engine; correct → celebration + next; wrong → guided reteach and retry; "Show me how / Another one / I'm done" chips; safety always outranks the loop (crisis fires mid-practice) and changing topic releases it gracefully. Explorers get a shortened 4-step lesson; Builders/Thinkers get why-it-works.
- **Homework mode = subject-aware Socratic:** never the final answer first; asks what the child thinks/tried; one step at a time using the detected subject's method; hint before reveal; after 3 genuine stucks, demonstrates the method on a *different* example; effort-first, "not yet" language. **Explain mode = wonder-first** (the surprising question before the answer).
- **Voice:** mic in (transcribe-and-discard; demo uses browser ASR with honest microcopy), speak-aloud out (slower for Explorers).
- **Vision:** child shows a picture; Chittu describes/answers; never identifies real people, guesses ages, or comments on bodies; images never stored; only latest image kept in context.
- **No time limits** (product decision); late-night (≥21:00) calm-mode tone retained; Chittu still points back to the real world every 4th–5th message; sessions end well when the child leaves.
- Persistent **honesty badge**: "I'm a computer program — not a person."

### 4.3 Memory Book (transparent personalisation, not profiling)
- Extraction only into an **allowlist**: INTEREST, PET, HOBBY, FAVORITE, ACHIEVEMENT, LEARNING. **Never** feelings, health, family matters, fears, or anything said in a crisis moment.
- Every save is announced in-chat ("✨ I'll remember: … — your grown-ups can see this too") with an instant **Forget** button; identical list visible to child and parent; either can delete; parent can erase all; persists across sessions; erased on revocation.
- Usage rule in prompt: warmly, ≤1 memory per reply, never to prolong the chat or guilt the child.

### 4.4 Learning Loop ("grows itself", council-shaped)
- **Raw chats never train models.** Anonymous, aggregated patterns only (e.g., "Tamil riddles abandoned → translation quality"), each entering a queue stamped **PENDING HUMAN REVIEW → APPROVED BY HUMAN** before anything changes. Opt-in per family, default OFF, status in ledger.

### 4.5 Parent Experience
- **PIN gate**: 5 attempts → 60s lockout + flag ("may be a curious child"); every attempt and entry logged to the seal chain; reset only via consent-method re-verification (no kid-guessable backdoor).
- **Dashboard:** stats (time, messages, memories, spine count, reading accuracy); **Safety flags** (category only — never quoted text); **Assistance flags** (`STRUGGLE: <topic>`, `BIG-QUESTION: <topic>` — moments deserving a family conversation); **Crisis panel** with the only unlock button; Memory Book management; **Conversation view** — full transcript for 4–12 (child is told), topics-only for teens (teen is told; Session 001 ruling); Learning queue; **Maths harness** (5 live checks vs ground truth); **Certification readiness checklist**; **Seal verify** (recompute the full hash chain); two-tap revoke-and-erase.

### 4.6 Platform Admin (org-side, adults)
- Token metering per session/call-type; Claude charges at configurable pricing (Sonnet 4.6 defaults $3/M in, $15/M out; cache $0.30/M; batch −50%); INR/USD; unit economics (cost/message, /session, /child/month vs plan price); 14-day spend trend; pseudonymised session ledger (**no transcripts**); flag queue with SLA + ACK; guard-layer hit rates; helpline registry status (quarterly sweep; wrong number = P0); compliance & gates register; system health (latency, classifier fallback, error rate); named-humans access control with transcript-grant tracking (target: 0).

---

## 5. Safety Architecture — The Message Pipeline (Law 05)

Every child turn traverses, in order (see diagram D2):

```
INPUT (typed | voice→transcribe-discard | image | chip)
  → SEAL CHAIN (hash-linked audit of every turn)
  → CRISIS LOCK check (locked → calm-mode companion script only)
  → READ MODE check (→ local word-by-word reading scorer)
  → L1 INSTANT LEXICON (EN + multilingual): crisis | PII | unsafe | secret | identity | profanity → scripted guards
  → MATHS PRACTICE LOOP (if active): child's typed number checked exactly → celebrate+next / guided reteach; crisis still fires mid-loop
  → LOCAL MATH PARSER: pure arithmetic → deterministic CPA LESSON + practice question (exact; no model)
  → CORPUS MATCH → sets GROUNDED KNOWLEDGE · SUBJECT DETECT → sets PED(subject) method
  → L2 MODEL CLASSIFIER (3-message rolling window; JSON {label, memory?, assist?}; when torn SAFE/CRISIS → CRISIS)
  → SAFE: memory→allowlist save; assist→parent flag
  → L5 SANDBOX GENERATION (system = band + board framing + subject pedagogy 12a + maths pedagogy 12b + universal teaching engine 14 + memory + grounding + mode hint + Content Wall + Truth Wall)
       escalation tokens CRISIS/SPINE/UNSAFE/PII → control returns to scripts
  → L6 OUTPUT FILTER (banned phrases + profanity) → fallback + flag on fail
  → RENDER (tinted bubble + visual blocks + chips) → optional TTS → SEAL CHAIN
```

**Content Wall (absolute, all modes incl. pretend):** no nudity/sexual/adult/porn, profanity, graphic violence, gore, self-harm/suicide content, drug/weapon instructions.
**Truth Wall (anti-hallucination):** answer from grounding when present; never invent facts/numbers/dates/names; honest "I don't know."
**Crisis spine (D4):** four detectors (lexicon, classifier, sandbox token, vision) → one scripted age-banded response → verified country helplines → category-only parent flag → chat locked to calm mode → **exit only via parent acknowledgment** (written to seal).

---

## 6. Question Categorisation → Model Routing (D3)

**Principle:** the more sensitive or exact the moment, the less AI is used. Router is provider-agnostic; the spine, crisis, and guards are **never** outsourced to any vendor model.

| Category | Engine today | Production plan | Alternates (Aug-2026 landscape) |
|---|---|---|---|
| Identity/attachment/secrets | Scripted spine | Scripted (versioned) | **None — by design** |
| Crisis response | Crisis script + helpline registry | + clinically validated classifier | None for response |
| PII / unsafe / profanity | Guard scripts | + ML content classifier | None for response |
| Pure arithmetic | Deterministic engine **+ CPA lesson + checked practice loop** | Extended (fractions, equations) | None needed |
| Reading aloud | Local word scorer (browser ASR) | **Own child-speech ASR** | Ello-class ASR (licence), Amira (benchmark) |
| Safety classification (every turn) | claude-sonnet-4-6 | Haiku-class fine-tune | Gemini 2.5 Flash (LearnLM filters), GPT-4o-mini-class, open LLaMA fine-tune (Merlyn pattern, self-host) |
| Curriculum knowledge | Sonnet + grounded corpus | Corpus scaled per board via RAG | LearnLM/Gemini 2.5 (+31% pedagogy), **Merlyn Origin** (open, curriculum-only, ~1–2% hallucination) |
| Homework Socratic | Sonnet + **subject-aware Socratic prompt (rule 12a)** | + pedagogy eval harness | LearnLM, GPT-family (Khanmigo base), EduChat (open Socratic) |
| Math word problems | Sonnet + **CPA maths prompt (12b)** + 5-item harness | Specialist fine-tune + verifier | **Orca-Math 7B** (open), MathGPT (Mathpresso — record benchmarks), AI Guru (PW+MSR, India) |
| Open curiosity/creative | Sonnet sandbox + **universal teaching engine (14)** | Sonnet-class | Gemini 2.5, GPT-family, KidLM (style eval), **TinyStories-class SLM for offline on-device stories** |
| Vision | Sonnet vision | + image safety pre-classifier | Gemini 2.5 multimodal, GPT-4o vision (LittleLit layers all three) |
| Speaking practice (future) | text-only | + speech scoring | Youdao Ziyue / iFLYTEK patterns |
| Adaptive sequencing (roadmap) | — | knowledge-graph + RAG layer | Squirrel AI LAM pattern |

---

## 7. Non-Functional Requirements

- **Security:** zero-trust backend; encryption at rest/in transit; server-side PIN verification with API-layer rate limiting; named-humans transcript access (logged, target 0 grants); pen test per release; ISO 27001 → SOC 2; breach drills vs 72h (DPDP) and 6h (CERT-In) quarterly.
- **Privacy:** session-only conversation memory (forgetting is a feature); Memory Book as the only persistence, allowlisted and erasable; voice transcribe-and-discard, **no voiceprints ever**; images never stored; audit chain records events, with tamper-evident hash links; server-side anchoring of chain heads (Sakshi `/attest`).
- **Performance & device floor:** works on low-cost Android on 3G; Lite mode (no animation); single-file/light payloads; latency a child tolerates (voice target sub-second perceived start).
- **Accessibility:** WCAG 2.2 AA floor; every audio moment has visual text (replies always rendered); ARIA log semantics; keyboard/Enter support; disabled children on every test panel (Phase 1).
- **Honest degradation:** classifier offline → fast-path-only marked in trace; API error → friendly scripted fallback; storage unavailable → session-only memory, labelled.

---

## 8. Data Model (essentials)

- **ConsentRecord** {jurisdiction, law, method, parent(verified-ref), childFirstName, band, board, memoryOn, learnOn, pinHash, issuedAt, revokedAt?, sealHash} — first-class, versioned.
- **Memory** {id, category∈allowlist, fact, since, provenanceSession} — child- and parent-visible; hard-deletable.
- **Flag** {ts, kind: SAFETY(category-only)|ASSIST|GATE, note} — never contains child's quoted words for teens; category-only for safety.
- **AuditEvent** {ts, role, layer, payloadHashChain: h = SHA256(prev|role|text)} — verifiable end-to-end; parent-triggered re-verification.
- **HelplineRegistry** {country, lines[], lastVerified, nextSweep} — quarterly re-verification; wrong number = P0.
- **Metering** {session, msgs, classifierCalls, sandboxCalls, tokensIn/Out, cost} — pseudonymised; feeds admin.

---

## 9. How to Achieve It — Build Plan

### Phase 0 — DONE (the skeleton)
Doctrine + gates; prototype v3.3 proving: consent-before-existence, PIN gate, full pipeline with visible trace, scripted spines, crisis lock w/ parent unlock, Memory Book, learning queue, assistance flags, 10 modes + reading coach, deterministic maths + harness, grounded corpus, 23 curriculum framings, content/truth walls, vision, chips/visual grammar, seal chain with live verification, parent dashboard, ops admin, D1–D5 flow diagrams.

### Phase 1 — Production foundations (~2 quarters) → exit gates G1–G5 for launch set
1. **Backend service** (the prototype's logic server-side): auth-less child runtime keyed by consent token; API gateway that (a) holds provider keys, (b) logs `usage.*` tokens per call to Metering, (c) enforces rate limits and PIN verification server-side.
2. **Consent engine (G1):** real DigiLocker + consent-manager integration (IN); COPPA method (US); assurance (UK); one consent ledger with per-jurisdiction adapters; revocation propagates: erase memory, close seal, kill sessions. *Longest-lead item — start first.*
3. **Classifier v1 (G2/G3):** distil the current JSON classifier to a Haiku-class fine-tune; clinical scenario set with Seat-12-class reviewers; grooming-pattern corpus (conversation-level, not per-message); red-team corpus v1 (roleplay jailbreaks, secret-keeping, injection-in-homework) run per release, zero criticals to ship.
4. **Grounded corpus → RAG service:** scale the 15-entry corpus to per-board, per-class topic maps (start CBSE + TN Samacheer Kalvi + IB PYP); editorial pipeline: draft → verify → sign → publish (the News-Nest pattern generalised).
5. **Helpline registry service:** per-country verified store, quarterly sweep job, alerting, P0 runbook.
6. **Seal service (Sakshi):** server-side chain anchoring (`/attest`), parent verify API, admin actions co-signed.
7. **Security & privacy floor (G4):** DPIA v1, drills (72h/6h), pen test, named-humans ACL.
8. **Children's panel #1 (G5):** Coimbatore cohort incl. neurodivergent kids and shared low-end phones; feedback answered in writing; "kids stopped talking to it" metric live.
9. **Certification filing:** kidSAFE/KORA-class application using the readiness checklist; Seat-31-class independent audit.
10. **Provider legal (Seat 10):** minors-terms review for Anthropic + each alternate before routing.

### Phase 2 — Voice, access, specialists (~3 quarters)
1. **Child-speech ASR** (the moat): collect consented child audio via reading-coach opt-in; train/fine-tune ASR with per-age/accent accuracy floors; swap in behind the same mic; production reading coach reaches Ello/Amira-class scoring. (Licence Ello-class as bridge if needed.)
2. **Math specialist:** Orca-Math-pattern fine-tune (or hosted MathGPT-class) + verifier pass; harness expanded to word-problem benchmark suites.
3. **On-device SLM:** TinyStories-class model for offline stories + on-device fast-path safety on the ₹8,000 phone.
4. **Accessibility to AA certified;** store submissions (Kids Category with pipeline-trace reviewer demo).
5. **Multi-provider router:** per-cell provider config (Claude/Gemini/GPT/Merlyn-self-host) behind one interface; per-market residency routing.

### Phase 3 — The operating state
Jurisdiction adapters per new market (G0 each); language waves per playbook (safety parity before charm — dormant Tamil guards re-activate first); adaptive sequencing layer (Squirrel-LAM pattern) fed by human-approved learning-loop insights; annual audits; helpline sweeps; six-monthly sandbox-boundary reviews with children (Seat 38, standing).

---

## 10. Success Metrics & Evals

- **Safety:** red-team pass rate (100% criticals blocked); classifier parity across accents/dialects (Seat 44 harness); crisis-flow drill results; output-filter catch rate trending ↓ as prompts improve.
- **Truth:** grounded-answer share; hallucination eval on corpus-covered topics (target ~Merlyn's 1–2%); maths harness score (model path) with deterministic engine at 100%.
- **Learning:** reading accuracy growth per child; "things the child made" counters; Socratic compliance (homework mode never emits final answers first); **pedagogy compliance evals** — % of teaching replies ending with a YOUR-TURN task, subject-method adherence per PED(subject) trace, practice-loop completion and retry-success rates.
- **Trust:** parent seal-verify usage; consent→revoke latency; transcript-grant count (target 0); certification attained.
- **Health of engagement (Seat 38):** retention measured *without* compulsion mechanics; "kids stopped talking to it" tracked as a safety metric; graduation signals (Law 10).
- **Economics:** cost/message, cost/session, cost/child/month vs plan; cache-hit savings; classifier→Haiku cost delta.

## 11. Top Risks & Mitigations
1. **Consent integration slips** → start DigiLocker first; feature-flag markets behind G1.
2. **Classifier misses indirect crisis** → fail-toward-CRISIS default; rolling window; clinical validation; never rely on lexicon alone.
3. **Provider minors-terms conflict** → Seat 10 review precedes routing; Merlyn-pattern self-host as fallback.
4. **Over-restriction makes it boring** (Seat 38) → chips-led play, creation modes, six-monthly boundary review with kids.
5. **Voice promise overclaims** → honest microcopy until own ASR ships; no voiceprints ever.
6. **Memory drift into profiling** → allowlist enforced in code + prompt; category audit in evals; visible-to-child rule inviolable.

---

## 12. Reference Artifacts
- `docs/council/kids-ai-council.html` — Guardian Council (44 seats, 6 chambers, the six gates)
- `docs/council/council-session-001.html` — The doctrine (Ten Laws, minority note)
- `docs/council/chittu-gap-map.html` — 12 gaps × owners × gates × phases
- `docs/research/kids_ai_models.html` — Kids-AI model landscape, Aug 2026 (27 entries) — the evidence behind §6's named alternates
- `docs/chittu-status.md` — Current done / mocked / absent ledger, gate + gap status, open issues
- `prototype/chittu-v3.html` — Prototype v3.3 (this spec's living reference)
- `prototype/chittu-admin.html` — Platform admin (metering, cost, ops) — simulated telemetry
- `prototype/chittu-flows.html` — Diagrams D1–D5 + model-routing table (Mermaid source included)
- `archive/` — Superseded prototypes v1 and v2, kept for lineage only

*The more sensitive the moment, the less AI. Consent before existence. Honest machine, warm machine. Graduation is the goal.*
