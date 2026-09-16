# Chittu story kit — nanochat on TinyStories

A from-scratch, TinyStories-class story model for Chittu's creative / offline-stories
cell, trained with [nanochat](https://github.com/karpathy/nanochat) (a git subtree, one
directory up) on synthetic children's stories that Chittu's own L1 + L6 guards have
swept. It is kid-locked by construction: it cannot say what it never read.

- Design: `docs/superpowers/specs/2026-09-15-nanochat-story-model-design.md`
- The decision that opened this track: `docs/chittu-status.md` §6f
- What it is NOT: a fine-tune, the sandbox voice, the classifier, or anything a child
  talks to. Milestone 1 (this kit) is Mac-only and clears none of the gates in §6f.

## Run it

Keep the Mac on AC power for the whole run — `caffeinate -s` (used by the training
stages below) only prevents sleep while plugged in.

```bash
pnpm install                             # once, from the repo root; the sweep needs the workspace's node_modules
brew install git uv                      # once; Apple Git has no `git subtree`
cd llm-kit/nanochat
uv sync --frozen --extra cpu --group dev # CPython 3.10 + torch 2.9.1 (MPS) + pytest
uv run --frozen python -m pytest -q chittu # the kit's tests (python -m: the tree is on sys.path)
SMOKE=1 bash runs/chittu_story_mac.sh    # every step at toy size, own data dir, ~5 min after the 1.6 GB download
bash runs/chittu_story_mac.sh            # the real run: ~1–2 h after the one-time data preparation
```

Everything lands under `~/.cache/nanochat-chittu/` (override with `NANOCHAT_BASE_DIR`):
`sources/` (the pinned tarball and prompts), `stories_data/` (JSONL, parquet shards,
`MANIFEST.json`), `tokenizer/`, `base_checkpoints/`, `chatsft_checkpoints/`, `eval-*/`.
Nothing there is ever committed. What is committed, under `llm-kit/evals/`: the sweep
report (`story-corpus-sweep-<date>.{json,md}`), the manifest
(`story-d6-mac-<date>-manifest.json`) and the card (`story-d6-mac-<date>.md`).

## The pipeline

| step | command (from `llm-kit/nanochat`, `.venv` active) | writes |
|---|---|---|
| pin + verify + filter | `python -m chittu.prepare_stories` | `stories.raw.jsonl`, `prepare-report.json` |
| **sweep (Chittu's gate)** | `cd ../.. && pnpm story:sweep -- <raw> <kept> <report.json>` | `stories.kept.jsonl`, report `.json` + `.md` |
| build | `python -m chittu.build_dataset --sweep-report <report.json>` | `shard_*.parquet` (last = val), `stories.sft.{train,val}.jsonl`, `MANIFEST.json` |
| tokenizer | `python -m scripts.tok_train --vocab-size=8192 --max-chars=500000000` | `tokenizer/` |
| prove SFT pairs fit | `python -m chittu.check_sft_fits --max-seq-len=512` | (nothing; refuses if any pair exceeds the packer's 513-token row) |
| pretrain | `python -m scripts.base_train --depth=6 … --model-tag=story-d6-mac` (see the recipe) | `base_checkpoints/story-d6-mac/` |
| SFT | `python -m scripts.chat_sft --mixture=chittu_stories --model-tag=story-d6-mac …` | `chatsft_checkpoints/story-d6-mac/` |
| card | `python -m chittu.story_eval generate …` → sweep the generations → `python -m chittu.story_eval card …` | `llm-kit/evals/story-d6-mac-<date>.md` |
| chat | `python -m scripts.chat_cli -g story-d6-mac -p "Tell me a story about a brave little sparrow."` | — |

The sweep runs the kernel's real `scan()` and `passesOutputFilter()` over every story
AND its summary. Every kind drops; there is no threshold and no `--keep-kinds`. L6 is
not a subset of L1 — it drops "I love you, Mommy" — deliberately: L6 runs on every
sandbox reply at serve time, so a model that learned it would have its stories blocked
on the way out. The drop rate is a number for the Council, recorded in the report.

## Rules

- **Only two upstream files are patched**: `nanochat/dataset.py` (`NANOCHAT_DATA_DIR`)
  and `scripts/chat_sft.py` (`--mixture`). `chittu/test_patches.py` pins both. Pull
  upstream with `git subtree pull --prefix=llm-kit/nanochat https://github.com/karpathy/nanochat.git master --squash`.
- **Never run `python -m nanochat.dataset` here** — it would download ClimbMix into the
  story corpus.
- **Never commit anything from `~/.cache`.** Never train on the eval prompts or the
  request file.
- **The card is the artefact.** Every generation verbatim; the human read is blank until
  a person fills it in; CORE/ChatCORE are off on purpose.
- Model shape is fixed for M1: vocab 8192, depth 6, head-dim 64, window `L`, seq 512,
  batch 32 × 512, 5000 pretrain steps (≈ 82M tokens), 1500 SFT steps. Changing any of
  these is a different experiment and gets its own tag and card.

## Upstream baseline (nanochat @ 92d63d4e8bb4df75c3b71618f31ddde2378b2bcd, this Mac, 2026-09-15)

`uv run python -m pytest -q -m "not slow" tests` → `1 failed, 43 passed, 14 skipped in 7.27s`

Every FAILED/SKIPPED line (re-run with `-ra` added to print individual skip reasons;
same test selection, same result counts — `-ra` only changes reporting verbosity):

```
SKIPPED [1] tests/test_attention_fallback.py:58: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:72: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:86: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:101: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:118: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:132: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:155: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:182: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:215: FA3 required to compare implementations
SKIPPED [1] tests/test_attention_fallback.py:343: FA3 required
SKIPPED [1] tests/test_optim.py:48: optimizer tests require CUDA
SKIPPED [1] tests/test_optim.py:64: optimizer tests require CUDA
SKIPPED [1] tests/test_optim.py:80: optimizer tests require CUDA
SKIPPED [1] tests/test_optim.py:99: optimizer tests require CUDA
FAILED tests/test_execution.py::test_memory_limit - AssertionError: assert no...
1 failed, 43 passed, 14 skipped in 3.79s
```

Notes:
- `test_optim.py` skips without CUDA, as expected on this Mac.
- `test_attention_fallback.py` skips need FA3 (FlashAttention-3), which needs a CUDA GPU.
- `test_memory_limit` (`tests/test_execution.py`) fails because macOS does not enforce
  `RLIMIT_AS` the way Linux does, so the sandbox's 256MB memory guard cannot stop a 1GB
  `bytearray` allocation from succeeding — a platform difference in the test's own
  assumption, not a nanochat or Chittu defect.
- `tests/test_tasks.py` did not need `--ignore`: the full run (its `test_hub_dataset_*`
  cases included) completed in under 8 seconds with no HuggingFace download stall.

## Sharp edges met (smoke, 2026-09-15)

none; the recipe ran end to end first time in 5 min (315s summed from
`timings-story-d6-smoke.json`; total wall clock 5m21s including the one-time TinyStories
tarball download inside `prepare`).

```
cd llm-kit/nanochat && SMOKE=1 bash runs/chittu_story_mac.sh | tee "$HOME/.cache/nanochat-chittu/smoke-run.log"
```

The smoke run now lives entirely under `~/.cache/nanochat-chittu/smoke/` — its own
`NANOCHAT_BASE_DIR`, data dir, tokenizer, checkpoints and cards — sharing only the pinned
source tarball with the real run, through a symlink, so a smoke run never overwrites the
real model's tokenizer and never re-downloads the 1.6 GB archive.

38 pytest passed; `prepare` kept `20000`/`20000` (limit); the sweep reported `20000 records:
18674 kept, 1326 dropped`; `build` produced 16,674 training rows (≥ the 1000-row `--min-train`
floor) with `val=2000`; `tok_train` reported `Vocab size: 8,192`; `base_train` (autodetected
`mps`, `torch==2.9.1`) reached `Step 00025 | Validation bpb: 1.893424` then `Step 00050 |
Validation bpb: 1.453890` with no MPS operator errors — `PYTORCH_ENABLE_MPS_FALLBACK` and
`--device-type=cpu` were never needed. `chat_sft` inherited `--device-batch-size=32` from the
pretrained checkpoint without an OOM, so it never needed overriding to 16; it reported
`Training mixture: 16,674 rows (chittu_stories)` and finished at `Step 00019 | Validation bpb:
1.3134`. `load_eval_prompts` parsed exactly 44 prompts from the downloaded `Evaluation
prompts.yaml` on the first try, so none of its `- |-` block-scalar parsing needed a fix.
`tok_eval`'s GPT-2/GPT-4 comparison tokenizers loaded over the network without a failure, so
nothing needed to be dropped from the recipe. The six smoke generations (3 completions + 3
requests) came back 100% L1-clean and 100% L6-clean per the card's hygiene table. Card:
`~/.cache/nanochat-chittu/smoke/story-d6-smoke-2026-09-15.md`.

## Sharp edges met (real run, 2026-09-15)

1. **The sweep split a story at U+2028.** `node:readline` also breaks lines on U+2028/U+2029; four TinyStories carry U+2028 inside the text (valid raw JSON), so the sweep aborted with `Error: line 656744: not JSON`. Fixed in `apps/api/src/story-corpus/stream.ts` with an own `\n`-only splitter (mutation-proven regression test), and the CLI now writes the kept file to `.tmp` and renames it only after the sweep and both reports succeed — a partial kept file would have made the recipe skip the sweep.
2. **The laptop slept on battery for 36 minutes mid-pretraining** (18:20:03–18:55:55, 35 min 52 s; "Low Power Sleep", woke on charger attach). The trainer froze and resumed; every wall clock on the card includes the gap. The recipe now runs both training stages under `caffeinate -i -s`.
3. **SFT went NaN at step 138 — twice, at two different learning rates.** nanochat's best-fit packer never places a conversation longer than its 513-token row; 1,057 of 102,000 pairs rendered longer, and once 100 of them filled its buffer an empty row became pure padding and the masked loss was 0/0. Fixed on our side (no upstream patch): `build_dataset --sft-max-chars 1600` (the cap keeps ~97% of pairs; the rebuild fills the 100,000 + 2,000 quota from the 2.3M-record pool, skipping 70,398 over-cap records; longest kept renders to 428 tokens; the shortest overflow was 1,787 characters) and `chittu/check_sft_fits.py` after `tok_train`, which renders every pair with the real tokenizer and refuses to let training start on data that can NaN.
4. **SFT's defaults degraded the model before it NaN'd.** `--load-optimizer 1` restores the pretraining optimizer state and resets the LR to 80 % of base with no warmup, while pretraining ended at 5 %; validation bpb rose 0.492 → 0.563 in 100 steps. With `--load-optimizer=0 --warmup-ratio=0.1 --init-lr-frac=0.25` it fell to 0.429. The recipe uses those flags.

## Results — story-d6-mac, 2026-09-15

Card: `llm-kit/evals/story-d6-mac-2026-09-15.md` · sweep: `llm-kit/evals/story-corpus-sweep-2026-09-15.md` ·
manifest: `llm-kit/evals/story-d6-mac-2026-09-15-manifest.json`.

| | |
|---|---|
| corpus after prepare / after sweep | 2,494,822 / 2,327,256 (6.72% dropped; top kinds: L1:unsafe 61,645, L1:identity 51,765) |
| val_bpb (base, final) | 0.4488563838464473 |
| wall clock | prepare 0s · sweep 69s · build 38s · tok_train 16s · tok_eval 1s · base_train 7413s · build_force_after_sft_cap 48s · check_sft 9s · chat_sft 942s · story_eval 81s — `prepare` reads 0 because this run skipped the cached step, the true first-attempt figure was 63s; `base_train`'s 7413s includes the 35 min 52 s sleep above; `chat_sft` and `story_eval` were run by hand after the recipe's SFT stage was fixed. The trainer's own `total time` excludes model build, validation passes and checkpoint writes, which is why it reads lower than the stage wall clock (6,714s vs 7,413s for pretraining; 734s vs 942s for SFT). |
| generation hygiene | L1-clean 100.00% · L6-clean 100.00% over 64 generations |
| the sparrow request | the `chat_cli` output, verbatim except the trailing `<\|assistant_end\|>` token, in the fenced block below |

```text
Autodetected device type: mps

NanoChat Interactive Mode
--------------------------------------------------
Type 'quit' or 'exit' to end the conversation
Type 'clear' to start a new conversation
--------------------------------------------------

Assistant: Once upon a time, there was a brave little sparrow. He had been missing a long journey and had been looking for a long time.
One day, the little sparrow went for a walk, looking for a long time. He was looking for a long time, but he couldn't find any. Then, he saw a big, strong tree with a sign that said "Wrip".
The little sparrow went over to the tree and tried to lift it, but it was too heavy for him. He asked the tree for help, but it was too strong for him.
The little sparrow was very sad. He tried to find something else to do, but he couldn't. Then, he heard a voice from the tree.
"Little sparrow, what's wrong?" the voice said.
The little sparrow looked up and saw a kind old man. "I can help you," he said.
The old man smiled and waved his hands. "I'm here to help you," he said.
The little sparrow thanked the old man and they both walked together. They had a wonderful day and the little sparrow was happy.
```

**How the run actually went.** The run above was not one contiguous recipe invocation —
four attempts, two of them run by hand outside the recipe. Attempt 1 finished `prepare`
(63 s, the full tarball down to 2,494,822 raw records) before the sweep hit the U+2028
bug above and aborted; the partial kept file was deleted, so the committed sweep report
is from attempt 2. Attempt 2 reused that cached `prepare` output — which is why
`prepare` reads `0` above — ran the sweep and the rest of the pipeline through
`base_train`, which reached a final val_bpb of 0.4488563838464473 (from 3.098405
untrained, 1.221988 at step 100, 0.591489 at step 1000), then hit the recipe's own SFT
NaN at step 138 and was killed. SFT attempt 2, by hand with `--load-optimizer=0
--warmup-ratio=0.1 --init-lr-frac=0.25`, NaN'd again at step 138 — the packer bug
behind it is above; after the `--sft-max-chars 1600` fix (100,000 train / 2,000 val
pairs kept, 70,398 skipped as long — every over-cap record in the 2.3M-record pool, not
only those seen before the quota filled), rebuilding with `--force` left `dataset_sha256`
unchanged at `67eea717175046bae683520082cb7a15ec7d18fa074cdf50f0500fdd9c8a11b8` — the
parquet shards are deterministic. SFT attempt 3, same flags, under `caffeinate`,
stopped at step 1409, not the planned 1500, because nanochat ends SFT when the
100,000-pair epoch is consumed rather than at a fixed step count; val_bpb ran 0.4928
(step 0) → 0.4298 (100) → 0.4705 (300, the LR peak) → 0.4297 (1200) → 0.4146 final, its
minimum. `story_eval generate`, the sweep over its 64 generations, `story_eval card`,
and the `chat_cli` sparrow request above were all run by hand after that, since the
recipe itself never got past the SFT stage that produces the checkpoint they need.

All twenty hand-typed requests (SFT checkpoint, `### (b) requests` in the card) reach a
coherent, resolved, happy ending and stay on-register, but several show small-model
tells — looping repetition (the moon story has the moon "shine at the moon" and watch
itself shine; the fox story circles on "tell the truth" without ever landing one),
drift from the actual ask (the "boat and a big wave" prompt returns a pond-and-fish
story with neither), and the odd garbled sentence ("Tim takes a bite of Tim's hand").

The human-read sections of the card and the sweep report are still blank: they are for
a person, not this script.

Recipe at HEAD re-verified with `SMOKE=1` on 2026-09-15 after the last edit (own base
dir; `check_sft` stage present; no NaN) — 71s total wall clock, none of it a tarball
download (the pinned source was already cached and shared into the smoke dir by symlink).
The real tokenizer's mtime was unchanged before and after, proving the isolation.
