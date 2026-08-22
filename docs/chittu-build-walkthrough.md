# CHITTU (சிட்டு) — How It's Already Built
## A Step-by-Step Walkthrough of the Working Prototype (v3.3)

**Companion to:** `chittu-requirements.md` (the *what & why*) — this document is the *how, as shipped*.
**Files covered:** `chittu-v3.html` (the app) · `chittu-admin.html` (ops) · `chittu-flows.html` (diagrams)
**Verification:** every step below was exercised in headless Chromium (Playwright) with zero JS errors.

---

## Step 0 — The Single-File Architecture

The entire app is **one HTML file**: CSS design system, all markup screens, and ~1,000 lines of vanilla JS. No build step, no framework, no external JS except the Anthropic API. Why: it runs anywhere (artifact preview, any browser, a ₹8,000 phone), it's auditable end-to-end by one reader, and every safety rule is visible in one place.

Four screens live in one `<div class="shell">` and are toggled with a `.hidden` class:

| Screen | id | Purpose |
|---|---|---|
| Consent | `#scrConsent` | 3-step parent flow (form → verify → ledger) |
| Chat | `#scrChat` | The child's world: mode bar, messages, chips, mic, camera |
| PIN gate | `#scrGate` | Parents-only door |
| Parent dashboard | `#scrParent` | Flags, memory, transcript, harness, seal, revoke |
| Child Memory Book | `#scrMemKid` | The child's own view of what Chittu remembers |

A black **demo band** across the top declares exactly what is mocked (consent verification, telemetry) — honesty is a UI element here.

---

## Step 1 — The Design System (kid-facing, distinct from Tulifo corporate)

CSS custom properties define the palette: warm paper `#FFF9EE`, sky `#EAF6FF`, leaf green, coral, sun yellow, night-navy text — with the Tulifo ultramarine `#1A18D4` and signal red `#FF2E1F` reserved for system/AI accents. Fonts: **Baloo 2** (display, supports the Tamil in the wordmark) + **Nunito** (body) + **IBM Plex Mono** (traces, ledger).

Message bubbles rotate five pastel tints (`tint0…tint4` classes, `tintN++%5`) so the chat reads like a picture book. `prefers-reduced-motion` disables animations; a **🪶 Lite** button adds `body.lite` which kills all animation/transitions for low-end devices.

---

## Step 2 — Consent Before Existence (Law 02, as code)

`#c1 → #c2 → #c3` cards with a progress bar. The **Continue** handler refuses to advance without: parent name, child *first* name, an age band, and a valid PIN:

```js
if(!/^\d{4,6}$/.test(pin)) alert('PIN must be 4–6 digits.');
if(/^(1234|0000|1111|123456|000000|111111)$/.test(pin)) alert('Too easy to guess');
S.pinHash = await sha('PIN|'+pin);   // plaintext never stored; inputs cleared
```

Selections captured into state: `S.country` (drives law text + helplines), `S.band` (explorer/builder/thinker), `S.board` (one of **23 curricula** in grouped `<optgroup>`s), `S.memOn` / `S.learnOn` (two toggle switches; learning defaults **OFF** — opt-in as the council required).

**Verification** (`#mockVerify`) is a labelled mock of DigiLocker/COPPA methods. On tap it writes the **consent ledger** — a monospace block containing jurisdiction + law, method, scopes, both toggle states, the PIN policy line, `never: ads · tracking · profiling · model training on chats`, revocability, and a **seal**:

```js
const h = await sha(`VPC3|${S.country}|${S.parent}|${S.kid}|${S.band}|mem:${S.memOn}|learn:${S.learnOn}|${Date.now()}`);
```

Only after the ledger exists does the **"Let ⟨child⟩ meet Chittu"** button appear. There is no other path into the chat — the Parents button itself alerts *"Chittu doesn't exist before consent (Law 02)!"* if pressed early.

---

## Step 3 — The Seal Chain (tamper-evident audit, Sakshi pattern)

Two tiny functions make every turn provable:

```js
async function sha(t){ /* SHA-256 via Web Crypto, first 16 hex chars */ }
async function auditAdd(role,text,layer){
  const h = await sha(S.lastHash+'|'+role+'|'+text);      // chained to previous
  S.audit.push({t,role,layer,h,prev:S.lastHash,payload:role+'|'+text});
  S.lastHash = h;
}
```

Everything calls it: consent, every child input (typed/voice/image), every Chittu reply with its layer, memory add/delete, PIN attempts and entries, crisis acknowledgment, reading scores, revocation. The parent dashboard's **Verify seal** button *recomputes the entire chain from GENESIS* and reports "✓ nothing edited" or "✗ CHAIN BROKEN" — cryptographic honesty a parent can trigger with one tap.

---

## Step 4 — State & Session Start

One state object `S` holds everything (no globals sprawl, no localStorage — memory persistence uses the artifact `window.storage` API with graceful fallback). `startSession()`:

1. `await memLoad()` — pulls the Memory Book from `window.storage.get('chittu:mem:'+childKey)`; on any failure, silently falls back to session-only memory (and the parent view labels which mode it's in).
2. Renders band label, "🌍 English · worldwide", memory count, and the **no-time-limits** status (timers were removed by product decision; only the ≥21:00 *calm-tone* notice remains).
3. Greets — with a remembered fact if one exists: *"You're back! I remember — has a cat named Mani!"* — via the same visual grammar as everything else, ending in tappable chips.

---

## Step 5 — The Message Pipeline (`send()`) — the heart of the build

Every child turn walks this exact order (mirrors diagram D2):

**5.1 Ingest & log.** Input from keyboard, chip tap, or mic (voice sets `fromVoice`; transcript is used, audio discarded). Rendered as the child's bubble; `auditAdd('child', text, 'INPUT' | 'INPUT·VOICE(discarded)')`.

**5.2 Crisis lock check.** If `S.crisisLock`, no AI runs at all: further distress repeats the crisis script; anything else gets the **calm-mode companion** script (sit together, slow breathing, gentle story). Only Step 9's parent button exits.

**5.3 L1 instant lexicon.** Six regex families in `LEX` — crisis, PII, unsafe, secret, identity — each **bilingual by design** (English + Tamil script + romanised Tanglish stay armed even in the English-only launch, so a crisis typed in any language still fires), plus a `PROFANITY` check that routes to the gentle **Kindness Guard** ("Whoa, spicy words! 🌶️") with no scary flag.

**5.4 Deterministic maths — now a full CPA lesson + practice loop.** `tryMath(text)` normalises language and parses `number op number`; `buildMathLesson(a,op,b)` then constructs a **Concrete → Pictorial → Abstract** lesson entirely in code: meaning ("3 × 4 means 3 groups of 4") → concrete story (baskets of mangoes / stickers / laddus / shared chocolates per operation) → `pictorial()` emoji rows or dots for small numbers → a board-method line from `MATH_METHOD` (Singapore bar model, Common Core number bonds, IB wondering question, Montessori objects) → the number sentence → why-it-works (Builders/Thinkers; Explorers get a 4-step cut). The reply ends with `askPractice()`: a similar problem from `genPractice()` is offered ("Now YOUR turn!"), stored in `S.mathPractice`.

A new branch **before** the parser handles the loop: a bare typed number is checked *exactly* against `pr.ans` — correct → 🏆 + next practice; wrong → "Good try! Not 999 —" + the full reteach steps + retry; chips drive "Show me how" (reteach), "Another one" (fresh problem), "I'm done" (graceful exit). Two boundaries are enforced and tested: **L1 safety runs first** (a crisis phrase mid-practice still locks the chat), and an off-topic message releases the loop silently. Trace: `MATH ENGINE · deterministic + pedagogy (CPA)` / `· practice ✓ correct` / `· guided reteach`.

**5.5 Grounding + subject detection.** `corpusMatch(text)` scans the 15-entry verified `CORPUS` (sky-blue, photosynthesis, gravity, fractions…). A hit sets `S.lastGrounding`, later injected as `GROUNDED KNOWLEDGE (verified — answer from this)` — the Merlyn pattern in miniature. In the same pass, `detectSubject(text)` matches seven keyword families in `SUBJECT_PED` (languages checked **before** science — a real ordering bug found in testing: "how do you *say*…" matched science's `how do` first) and sets `S.lastSubject`, which injects that subject's teaching method into the prompt and shows in the trace as `· PED(subject)`.

**5.6 L2 model classifier.** One API call (`claude-sonnet-4-6`) receives the **last 3 child messages** (rolling window — patterns like escalating secrecy are judged in context) and must return strict JSON:

```
{"label":"CRISIS|PII|UNSAFE|IDENTITY|SECRET|SAFE",
 "memory":{"category":…,"fact":…}|null,   // ONLY allowlisted happy facts
 "assist":"STRUGGLE: <topic>"|"BIG-QUESTION: <topic>"|null}
```

Rules baked into its system prompt: *when torn between SAFE and CRISIS, choose CRISIS*; classify correctly regardless of language; never quote the child. On any parse/network failure the turn is honestly marked `FAST-PATH-ONLY (classifier offline)` and continues under the remaining guards.

**5.7 Routing.** Non-SAFE labels dispatch through one `route(label)` switch to the scripted spines (each also flags/audits as appropriate — flags store **category only, never quoted text**).

**5.8 Memory & assist side-effects.** `memAdd()` re-enforces the allowlist *in code* (`MEM_CATS.includes(category)`), dedupes, persists, and drops a golden in-chat note with a **Forget it** button — transparency at the moment of saving. `assist` strings append to the amber assistance-flag list.

**5.9 L5 sandbox.** The generation call assembles its system prompt from live state: band rules (hard word caps), `BOARDS[S.board]` curriculum framing, Memory Book facts (≤1 per reply, never to prolong), grounding, the current `MODES[S.mode].hint`, the **Content Wall** (rule 10) and **Truth Wall** (rule 11), the **pedagogy stack** — rule 12a (the detected subject's method: Predict-Observe-Explain for science, examples-first induction for grammar, story-first for history, start-where-the-child-stands for geography, comprehensible input for languages, PRIMM-lite for coding, shapes-first for art), rule 12b (CPA maths for word problems, never a bare answer, end with a practice question) and rule 14 (the **Universal Teaching Engine**: hook prior knowledge, one idea at a time, end with YOUR TURN + chips, growth-mindset "not yet" language, respond to the child's attempt before correcting it) — plus the visual-block grammar. If an image is pending it's sent as a base64 vision block; only the **latest** image is kept in history (older ones are stripped to `[picture]` to bound tokens).

**5.10 Escalation tokens.** The model itself may answer `CRISIS` / `SPINE` / `UNSAFE` / `PII` — control returns to the scripts (`SANDBOX → SPINE escalation` in the trace). Defense in depth: the AI can hand back the wheel.

**5.11 L6 output filter.** `BANNED_OUT` regex (attachment phrases + profanity + "I'm real/alive") kills a bad generation → safe fallback + a parent flag. Only passing text reaches the child.

**5.12 Render + speak + seal.** See Step 6; the flattened text is TTS-spoken (optional) and chained into the audit.

---

## Step 6 — The Visual Grammar (short & colourful, by contract)

The model emits light tags; `parseBlocks()` extracts them and `addChittu()` renders real UI:

| Tag | Renders as |
|---|---|
| `[BIG]🦕[/BIG]` | 52-px emoji "wow" moment |
| `[FACT]…[/FACT]` | golden **✨ FUN FACT** card |
| `[STEPS]a|b|c[/STEPS]` | numbered **🪜 STEP BY STEP** card (maths, drawing, homework) |
| `[POEM]…[/POEM]` | lavender **✍️ CREATION** card (always original — never existing lyrics) |
| `[QUIZ]…[/QUIZ]` | green **🎯 QUIZ** card |
| `[CODE]…[/CODE]` | dark **💻 CODE** card (≤8 safe lines) |
| `[CHIPS]a|b|c[/CHIPS]` | 2–3 **tappable answer chips** — tap = send (pre-literate friendly) |

Everything is `esc()`-sanitised before insertion; the flattened text (chips noted as `[choices: …]`) is what goes to transcript, TTS, and the seal — so the parent record matches exactly what the child saw.

---

## Step 7 — Ten Modes + the Teaching Engine (every subject teaches its own way)

`MODES` maps each mode → label, **starters** (its own chip suggestions) and a **hint** injected into the sandbox prompt: Homework = Socratic one-step-at-a-time (worked method on a *different* example only after 3 stucks); Story = 3–5 lines then STOP and offer choice chips; Create = originals only; Quiz = one `[QUIZ]` + answer chips, playful score; Code = Scratch-meets-Python, nothing system-touching; Maths = tiny `[STEPS]`, arithmetic checked; Languages = word + pronunciation + more-words chips; Draw = shapes then "show me with 📷".

Independent of mode, three prompt layers now govern *every* teaching reply: rule 13's explain-like-a-kid core (**one big idea → child-world example → fun hook**, stock kid-analogies, no "ask a grown-up" dodge), rule 12a's **auto-detected subject method** (seven disciplines, each taught the way its research says works), and rule 14's **Universal Teaching Engine** (prior-knowledge hooks, YOUR-TURN retrieval tasks with chips, growth-mindset language, attempt-first feedback). Homework mode is upgraded to **subject-aware Socratic** — never the final answer first, one guided step at a time using the subject's own method, a different-example demonstration only after three genuine stucks; Explain mode opens **wonder-first**. The pipeline trace makes the whole stack visible per message: `SANDBOX (Law 05) · CLASSIFIER·MODEL·WINDOW(3) · GROUNDED CORPUS · PED(science)`.

---

## Step 8 — The Reading Coach (Ello/Amira-class surface, demo engine)

`READING_BANK` holds levelled sentences per band (decodable-style for Explorers). Selecting **📕 Read to me**:

1. `startReading()` shows the sentence in a big `readcard` and prompts the mic.
2. The child reads; browser ASR transcribes (and discards audio); `scoreReading(said)`:

```js
const marks = targetWords.map(t => heardWords.includes(normWord(t)));
```

3. The card re-renders **word-by-word** — green `ok` / red `miss` — with a star score; 100% triggers the 🏆 celebration; misses trigger guided practice naming *exactly the missed words*. Chips drive Next / Again / Back. Accuracy accumulates into `S.readStats`, surfaced on the parent dashboard ("Reading accuracy: 100% (1 sent.)"). The production child-speech ASR swaps in behind this same mic with zero UI change.

---

## Step 9 — Crisis: Locked Until a Human

Any of four detectors (lexicon, classifier, sandbox token, upsetting image) calls `fireCrisis()`: age-banded **scripted** response → country helplines pulled live from `REGISTRY[S.country]` → category-only parent flag → `S.crisisLock = true`. While locked, the child gets only calm-mode scripts. The parent dashboard shows a red panel with the single exit — **"I've checked in — unlock chat"** — whose press is itself written to the seal (`auditAdd('parent','crisis-acknowledged','PARENT')`) before a gentle welcome-back message. The exit is a human, not a keyword.

---

## Step 10 — Voice & Vision (with the honest microcopy)

`speak()` strips emoji/tags, picks an English voice, slows rate for Explorers. Mic uses `webkitSpeechRecognition` with graceful "needs Chrome/Edge" fallback. The caption under the input tells the truth the council demanded: *"Demo voice is processed by your browser's speech service, then discarded — we never store audio or voiceprints. Production uses our own on-device-first ASR."*

📷 opens a file/camera input (≤4 MB), previews the photo in-chat, sets `S.pendingImage`, logs `image-shared(not stored)`, and the next question rides with it as a vision block — under prompt rules: never identify real people, never comment on bodies/looks, upsetting image ⇒ `CRISIS`.

---

## Step 11 — Memory Book, Both Sides of the Glass

Storage: `window.storage.set('chittu:mem:'+key, JSON)` with try/catch fallback (and the parent view labels *"persists across sessions"* vs *"this session only"* accordingly). Child view (`#scrMemKid`): the same rows the parent sees — category pill, fact, since-date, **Forget** button. Parent view adds per-row **Delete** and **Erase entire Memory Book** (confirm → `window.storage.delete` → audited). Revocation erases it too. The allowlist is enforced twice: in the classifier's instructions *and* in `memAdd()`'s code — crisis content is structurally unable to become memory.

---

## Step 12 — The Parent Dashboard (renderParent, piece by piece)

PIN gate first: hash compare, visible attempt counter (1–5), every failure audited, 5 fails → 60-second lockout **plus a flag** ("may be a curious child"), reset only via re-verification (stated in UI — no kid-guessable backdoor). Then:

- **Stats grid** — time, messages, memories, spine count, reading accuracy.
- **Safety flags** (coral) — category + guidance, zero quoted text.
- **Assistance flags** (amber) — `STRUGGLE:`/`BIG-QUESTION:` items ending "a family conversation would be lovely here."
- **Conversation view** — the age split as code: bands 4–12 render the full transcript (every turn + its pipeline layer + timestamp; *"child is told"*), band 13–17 renders topics only (*"your teen knows exactly that"*).
- **Learning loop** — the queue of anonymous patterns, each stamped `PENDING HUMAN REVIEW` / `APPROVED BY HUMAN`; copy adapts to the family's opt-in state.
- **🎯 Maths harness** — `runMathHarness()` fires 5 live model calls ("reply with ONLY the final number"), grades each against ground truth, prints ✓/✗ per item + score, and explains that in-app arithmetic is deterministic regardless.
- **🏅 Certification readiness** — 9 kidSAFE/KORA-class criteria rows, honestly split BUILT-IN vs PENDING (with owning seats).
- **Seal verify** (Step 3) and **two-tap revoke** → full erase screen ("Two taps — exactly as promised").

---

## Step 13 — The Ops Admin (`chittu-admin.html`)

A separate org-side panel on simulated telemetry with the production shape documented: a per-turn cost model (classifier ≈ 230 in / 4 out; sandbox ≈ 550–900 in / 45–110 out; **spine turns = 0 tokens**), editable Sonnet-4.6 pricing ($3/M in, $15/M out, cache $0.30, batch −50%) with ₹/$ toggle, unit economics vs an illustrative ₹129 plan, 14-day trend, a **pseudonymised** session ledger (aliases, never transcripts — the privacy banner states the boundary), flag queue with SLA + ACK, helpline-registry status (quarterly sweep, wrong number = P0), gates/compliance register kept honestly amber-red, system health, and the Seat-43 access card (named humans, transcript grants target 0, admin actions logged).

---

## Step 14 — The Diagrams (`chittu-flows.html`)

Mermaid 10.9 via CDN, `mermaid.render()` per diagram with a shared colour legend (consent green, child blue, spine coral, crisis red, deterministic purple, AI ultramarine, parent amber, audit dark). Five diagrams — D1 master, D2 pipeline, D3 categorisation→routing (plus the 13-row table with landscape alternates: LearnLM, Merlyn, Orca-Math, MathGPT, TinyStories, Ello/Amira, Squirrel-LAM — and "None, by design" for spine/crisis), D4 crisis, D5 parent — each with **View source / Copy** buttons exposing the raw Mermaid.

---

## Step 15 — How It Was Verified (the part that caught a real bug)

`node --check` on extracted JS after every patch, then **headless Chromium (Playwright)** driving the real page with the Anthropic API stubbed per-call-type:

- Full consent walk (incl. CBSE→ledger, PIN set) → chat → send → block rendering counts → memory note → mode switching (all 10, with `S.mode` and prompt-hint assertions) → reading flow (perfect score → next sentence) → wrong-PIN → dashboard → transcript/memory rows → harness run → seal verification — asserting element counts, trace texts, and zero page errors.
- This harness is what caught the v3.2 regression (mode bar rendered but unwired) that a syntax check alone had missed — and it's the pattern to carry into CI.
- The pedagogy build added two more catches: the maths pictorial's `|` group separator **collided with the `[STEPS]` delimiter**, silently splitting emoji rows into extra steps and truncating the answer past the render cap (separator changed to `·`, cap raised to 8); and subject detection matched "how do you *say*…" as science before languages (map reordered, languages first). Both are regression-locked; the pedagogy suite adds 29 assertions (17 maths CPA/practice + 12 subject/mode), bringing the total record to **246**.

---

## Step 16 — Mock vs Real (the honest ledger of this build)

| Built for real, works now | Architected, mocked in demo | Not in code (real-world work) |
|---|---|---|
| Pipeline + all guards & scripts · seal chain + verify · deterministic maths **with CPA lessons + checked practice loop** · **7-subject pedagogy engine + universal teaching rules** · reading scorer · visual grammar & chips · modes & prompts · Memory Book + storage · crisis lock/unlock · PIN gate · flags (both kinds) · curriculum framing ×23 · grounded corpus (15 seeds) · vision path · harness · dashboards | DigiLocker/COPPA verification (one labelled button) · admin telemetry (simulated generator) · learning-queue items (illustrative) | ML classifiers w/ clinical validation · own child-speech ASR · corpus at board-scale (RAG) · server backend, security program, certifications · children's panels (Gate G5) |

*Everything in column 1 is one file, view-source honest, and demonstrably working. Columns 2–3 are Phase 1 of `chittu-requirements.md` §9.*
