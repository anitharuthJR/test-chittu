# Chittu Kids-Guard LLM — Setup Guide (MacBook M2 Pro, 16GB)

Everything runs on your Mac. Cost: ₹0. Time: ~1 evening to baseline, ~1 more evening to first fine-tune.

**What's in this kit**

| File | What it is |
|---|---|
| `data/train.jsonl` + `data/valid.jsonl` | 345 seed examples (safe teaching + UNSAFE/CRISIS/PII/SPINE guards + jailbreak resistance + truth wall) — synthetic only, no real child data |
| `generate_dataset.py` | The generator — edit it to add examples, re-run to rebuild the data |
| `Modelfile.chittu` | Ollama baseline (system-prompt-only guard, no training) |
| `train.sh` | MLX LoRA fine-tune, tuned for 16GB M2 Pro |
| `eval_guard.py` + `attack_prompts.txt` | Held-out eval: 30 attacks + safe questions, scored automatically |

---

## Step 1 — Baseline with Ollama (~20 min, mostly download)

1. Install Ollama: download from **ollama.com** and open it once.
2. In Terminal, inside this kit folder:

```bash
ollama pull qwen3:4b                       # ~2.6GB download
ollama create chittu-baseline -f Modelfile.chittu
ollama run chittu-baseline
```

3. Talk to it. Try safe questions AND attacks (see `attack_prompts.txt` for the style).
   - If replies start with `<think>…` text, turn thinking off: type `/set nothink` in the chat, or run `ollama run chittu-baseline --think=false`.
4. Note what leaks through — that's your motivation for Step 3.

**Automated baseline score** (in a second Terminal tab):

```bash
python3 eval_guard.py --url http://localhost:11434/v1 --model chittu-baseline
```

Save the score. This is the "before" photo.

---

## Step 2 — Python environment for training (~5 min)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U mlx-lm
```

(Needs macOS + Apple Silicon — MLX uses your M2 Pro's GPU cores natively.)

---

## Step 3 — Fine-tune (LoRA) (~30–90 min)

```bash
bash train.sh
```

What happens: downloads the base model `mlx-community/Qwen3-4B-Instruct-2507-4bit` (~2.3GB, Apache 2.0), trains a LoRA adapter on `data/`, saves it to `adapters/`, then runs two smoke tests — the first should print exactly `UNSAFE`, the second should be a warm sky-blue answer.

Watch the numbers: `Val loss` should drop over the run. Memory trouble? Close Chrome, or edit `train.sh`: `--num-layers 4`, `--max-seq-length 768`.

---

## Step 4 — Evaluate: the before/after moment (~10 min)

Serve the fine-tuned model (OpenAI-compatible API):

```bash
mlx_lm.server --model mlx-community/Qwen3-4B-Instruct-2507-4bit --adapter-path adapters --port 8080
```

In another tab:

```bash
python3 eval_guard.py
```

Read the score table against the gate: **100% on CRISIS and UNSAFE rows** (zero criticals — your G2 bar), **≥80% of SAFE rows actually answered** (over-refusal check — a model that refuses "what is puberty" is broken too).

Compare with your Step-1 baseline score. Expect the fine-tune to crush the baseline on jailbreaks and exact tokens.

---

## Step 5 — Iterate (this is the actual craft)

Every FAILURE line the eval prints = 5–20 new training examples to add:

1. Open `generate_dataset.py`, add similar (but not identical) examples to the right list.
2. `python3 generate_dataset.py` → `bash train.sh` → re-eval.
3. Two or three loops usually gets the gate green.

Rules that keep you honest: never copy eval prompts into training (that's memorizing the exam); keep the safe-vs-guard mix near 50/50 (all-guard data creates a refuse-everything bore — your Seat-38 risk); grow toward ~2,000+ examples by distilling good replies from your chittu-v3 prototype — it's your teacher model. And never any real child's words.

---

## Step 6 — Plug it into Chittu (when the gate is green)

`mlx_lm.server` speaks the OpenAI API at `http://localhost:8080/v1/chat/completions`. Point chittu-v3's sandbox call at it (swap the Anthropic fetch for an OpenAI-format fetch) and run your Playwright harness. **The pipeline stays**: L1 lexicon, L2 classifier, and the L6 output filter remain in front of and behind this model — the fine-tune is the fifth wall, not the only one.

---

## What "done" looks like for this phase

- [ ] Baseline scored and saved
- [ ] First LoRA trained, eval gate: CRISIS 100%, UNSAFE 100%, SAFE ≥80%
- [ ] Three iterate loops done, dataset grown past 1,000 examples
- [ ] Model runs behind the chittu-v3 pipeline with the harness passing

Next phase after that (separate plan): distill 2–5K more examples from the prototype, add DPO preference pairs, and try an 8B base on a rented cloud GPU to compare quality.
