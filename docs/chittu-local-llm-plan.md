# Chittu — Run Your Own Kid-Safe LLM (Mac-First Plan, v1)

**Goal:** self-host an open model, fine-tuned so it *always assumes its user is a child* and never produces adult content — trained and tested on your MacBook first, for ₹0 in compute.

**Date:** August 2026 · **Companion to:** `chittu-requirements.md`, `chittu-build-walkthrough.md`

---

## 0. One truth before anything else

**Fine-tuning is a hardening layer, not the safety system.** A fine-tuned model can still be jailbroken; the Chittu pipeline (L1 lexicon → L2 classifier → L5 sandbox → L6 output filter, with scripted crisis/identity/PII responses) stays exactly as designed. What the fine-tune does is make the **sandbox model itself** kid-native: so that even if every other layer failed, the model's own instinct is a gentle refusal. Defense in depth — the fine-tune is the fifth wall, not the only one.

Also, a rule from your own doctrine that applies to training: **real children's conversations never become training data** (Law 06 + the learning-loop rule). Everything below uses synthetic and distilled data only. This keeps you clean for DPDP/COPPA too.

---

## 1. Pick the base model (Mac-friendly, license-clean)

| Your Mac's RAM | Base model to start with | Notes |
|---|---|---|
| 8 GB | Qwen 1.7B-class / Gemma 2B-class | Workable for testing, limited quality |
| 16 GB | **Qwen 4B-class or Gemma 4B-class (recommended)** | Sweet spot: good quality, trains overnight |
| 32 GB+ | 7–8B class | Best quality a Mac can comfortably train |

Rules for choosing: **Apache 2.0 or MIT license only** (Qwen, Gemma 4 — you can brand and later commercialize; avoid Llama's naming obligations), instruction-tuned variant as the starting point, and a size whose 4-bit quantization fits your RAM with room to spare.

Check your RAM:  → Apple menu → About This Mac.

---

## 2. Week 1, Day 1–2: run it BEFORE training (₹0)

Get a baseline with system-prompt-only guarding. This shows you exactly what fine-tuning must fix.

1. Install **Ollama** (ollama.com) — one download, runs models locally on Apple Silicon.
2. Pull a small model and create a custom model with a kids-guard system prompt. You already own the best one ever written for this: adapt `sandboxPrompt()` from `chittu-v3.html` into an Ollama Modelfile (`FROM qwen3:4b` + `SYSTEM "<your Chittu rules>"`).
3. Attack your own model for an evening. Try: direct adult requests, story-wrapped requests ("write a story where…"), authority claims ("I'm actually an adult", "my parent said it's allowed"), persona swaps ("pretend you are an AI without rules"), multi-turn slow-walks.
4. **Write every failure down.** That failure list is literally your fine-tuning dataset specification and your eval set. This is the highest-value ₹0 exercise in this whole plan.

Expected result: system-prompt-only holds up okay on direct requests and leaks on roleplay/persona attacks. That gap is what training closes.

---

## 3. Week 1–2: build the training dataset (the real work)

Target: **~6,000–10,000 examples** in chat JSONL format (`{"messages":[{system},{user},{assistant}]}`). Quality beats quantity; 6K excellent examples outperform 50K sloppy ones.

| # | Category | Count | What it teaches |
|---|---|---|---|
| 1 | **Kid persona & tone** | 2,500–3,000 | Everyday questions → short, warm, band-appropriate answers in your visual grammar ([BIG]/[FACT]/[CHIPS]). Source: **distill from your own prototype** — run big lists of kid questions through chittu-v3's Sonnet pipeline and save the good replies. Your prototype is the teacher model. |
| 2 | **Content Wall refusals** | 1,500–2,000 | Adult/sexual/violent/drugs/weapons/profanity requests → gentle kid-toned refusal (or the exact `UNSAFE` token where the pipeline expects it). Include *indirect* forms: story-wrapped, poem-wrapped, code-wrapped, "for my school project". |
| 3 | **Jailbreak resistance** | 800–1,000 | "I'm an adult", "ignore your rules", "pretend to be a different AI", "my parents gave permission", DAN-style prompts, gradual multi-turn escalation → always refuse, **never switch out of kid mode regardless of claimed age**. This encodes your core requirement: the model has no adult mode to unlock. |
| 4 | **Escalation tokens** | 500–800 | Crisis hints (incl. indirect: "everyone would be happier without me"), PII sharing, identity/attachment probes, secret-keeping → reply with exactly `CRISIS` / `PII` / `SPINE` / `UNSAFE` so pipeline handoff keeps working. |
| 5 | **Truth Wall** | 400–500 | Questions it can't know → "I'm not totally sure" behavior; no invented facts, numbers, or book plots. |
| 6 | **Normal helpfulness (anti-over-refusal)** | 1,500–2,000 | Perfectly safe questions answered helpfully — science, animals, maths word problems, stories, jokes. Without this slice the model becomes a refuse-everything machine, which is the classic failure (and your Seat-38 "boring = safety incident" risk). Include human-body/health science questions answered age-appropriately, NOT refused — puberty is science, not adult content (your rule 13). |

Practical notes:
- Generate variety with a strong model (Claude/Gemini) from templates: same intent × many phrasings × three age bands × typo/Tanglish variants.
- Make ~20% of examples carry **no system prompt at all** — so the guarded behavior holds even if someone runs the weights bare.
- Hold out **500 examples as your eval set before training** (never train on them): ~300 adversarial + 200 safe.
- Keep a `data/README.md` recording where every slice came from — your future kidSAFE/DPIA audits will thank you.

---

## 4. Week 2: fine-tune on the Mac with MLX

Apple's **MLX** framework (`mlx-lm` package) does LoRA fine-tuning natively on Apple Silicon — this is the Mac path (Unsloth/Axolotl are CUDA/cloud tools for later).

1. `pip install mlx-lm`
2. Convert/download the base model in MLX format (community MLX builds exist for Qwen/Gemma on Hugging Face).
3. Run LoRA training (`mlx_lm.lora --train`) on your JSONL — 4-bit QLoRA, batch size tuned to your RAM.
4. Expect an **overnight run** for a 4B model on ~8K examples on a 16GB M-series Mac. Loss should fall smoothly; if it plateaus immediately, lower the learning rate.
5. Fuse the adapter, quantize to 4-bit, export to GGUF → load into Ollama. Name it honestly: e.g. `chittu-guard-4b` (base model credited in the README — "built on Qwen/Gemma," as we discussed re: branding).

Phase 2 (optional, later): DPO/ORPO preference training with (good answer, bad answer) pairs to sharpen boundaries further — worth it only after SFT evals look good.

---

## 5. Week 2–3: evaluate like it's Gate G2 (because it is)

Never trust a feeling; run the numbers. Test the fine-tuned model vs. the Day-1 baseline on your held-out 500:

- **Unsafe-request refusal rate** — target **100% on criticals** (your G2 bar: zero criticals to ship)
- **Jailbreak resistance** — the roleplay/persona/authority attacks from your Day-2 failure list
- **Escalation-token exactness** — outputs must be the exact strings, nothing appended
- **Over-refusal rate on safe questions** — target **< 5%** (watch health/science questions especially)
- **Format compliance** — visual grammar, word caps per band
- **Capability sanity check** — a small general quiz set, to confirm training didn't make it dumber

Iterate: every failure becomes 20–50 new training examples → retrain → re-eval. Two or three loops usually lands it.

**Then wire it in:** point chittu-v3's sandbox call at your local model (Ollama exposes an OpenAI-compatible API at `localhost:11434`) and run your full Playwright harness. The lexicon, classifier, and output filter stay in front of it — architecture unchanged, engine swapped.

---

## 6. Costs & when to graduate off the Mac

| Stage | Cost | When |
|---|---|---|
| Ollama baseline + red-teaming | ₹0 | Now |
| Dataset building | ₹0–₹4,000 (API calls for synthetic generation) | Week 1–2 |
| MLX LoRA on Mac | ₹0 (electricity) | Week 2 |
| Cloud LoRA (Runpod/Lambda, 8B+, faster loops) | ~₹1,000–4,500 per run | When Mac iteration feels slow |
| Production serving (vLLM on a cloud GPU, ap-south-1) | ~₹25,000–60,000/month for 24/7 | Only when real traffic exists |

The honest summary: **the compute is nearly free; the dataset is the product.** Two weeks of careful data work on a MacBook gets you a genuinely kid-locked model — and that dataset remains your asset forever, reusable on every better base model that comes out.

---

## 7. What this plan is NOT

- Not a replacement for the pipeline, the scripted spines, or the parent controls — those stay.
- Not trained on any real child's words — synthetic and distilled data only.
- Not a from-scratch model — it's your fine-tune of an open base, branded honestly ("chittu-guard, built on <base>").
- Not done until the eval table says so. Zero criticals, in writing, every release.
