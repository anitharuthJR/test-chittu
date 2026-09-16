#!/bin/bash
# The Chittu story model, end to end, on this Mac. Read chittu/README.md first.
#
#   bash runs/chittu_story_mac.sh             # the real run: ~1–2 h after the one-time data preparation
#   SMOKE=1 bash runs/chittu_story_mac.sh     # every step at toy size, in its own data dir, ~5 min
#
# Every command below is pasteable on its own from llm-kit/nanochat with .venv active.
# NEVER run `python -m nanochat.dataset` in this tree: with NANOCHAT_DATA_DIR set it would
# pour ClimbMix shards into the story corpus.
set -euo pipefail
cd "$(dirname "$0")/.."                                  # llm-kit/nanochat
REPO_ROOT="$(cd ../.. && pwd)"
export NANOCHAT_BASE_DIR="${NANOCHAT_BASE_DIR:-$HOME/.cache/nanochat-chittu}"
DATE="$(date +%Y-%m-%d)"

if [ "${SMOKE:-0}" = "1" ]; then
  # Smoke must NOT share the real run's NANOCHAT_BASE_DIR: nanochat writes the tokenizer
  # to $NANOCHAT_BASE_DIR/tokenizer with no tag, so a smoke tok_train would silently
  # overwrite the real model's tokenizer. Re-root everything under its own smoke/ dir;
  # only the pinned 1.6 GB source tarball is shared, via a symlink back to the real
  # sources/ (ensure_source's sha256 check still runs against it either way).
  ROOT_BASE="$NANOCHAT_BASE_DIR"
  export NANOCHAT_BASE_DIR="$ROOT_BASE/smoke"
  mkdir -p "$NANOCHAT_BASE_DIR"
  ln -sfn "$ROOT_BASE/sources" "$NANOCHAT_BASE_DIR/sources"
  export NANOCHAT_DATA_DIR="$NANOCHAT_BASE_DIR/stories_data"
  TAG="story-d6-smoke"; PREP_ARGS="--limit 20000"; BUILD_ARGS="--min-train 1000"
  TOK_CHARS=20000000; BASE_ITERS=50; SFT_ITERS=20; EVAL_EVERY=25; EVAL_TOKENS=131072
  PROBES="--max-completion 3 --max-requests 3"; EVALS_DIR="$NANOCHAT_BASE_DIR/cards"
  SEQ_LEN=512
else
  export NANOCHAT_DATA_DIR="$NANOCHAT_BASE_DIR/stories_data"
  TAG="story-d6-mac"; PREP_ARGS=""; BUILD_ARGS=""
  TOK_CHARS=500000000; BASE_ITERS=5000; SFT_ITERS=1500; EVAL_EVERY=100; EVAL_TOKENS=524288
  PROBES=""; EVALS_DIR="$REPO_ROOT/llm-kit/evals"
  SEQ_LEN=512
fi
mkdir -p "$NANOCHAT_DATA_DIR" "$EVALS_DIR"
TIMINGS="$NANOCHAT_BASE_DIR/timings-$TAG.json"
echo '{}' > "$TIMINGS"

timed() {   # timed <name> <command...>: run it, record wall-clock seconds for the card
  local name="$1"; shift
  local t0; t0=$(date +%s)
  "$@"
  local dt=$(( $(date +%s) - t0 ))
  python3 - "$TIMINGS" "$name" "$dt" <<'PY'
import json, sys
path, name, dt = sys.argv[1:]
d = json.load(open(path)); d[name] = int(dt); json.dump(d, open(path, "w"), indent=2)
PY
  echo "== $name: ${dt}s"
}

command -v uv >/dev/null 2>&1 || { echo "uv is missing: brew install uv" >&2; exit 1; }
uv sync --frozen --extra cpu --group dev
source .venv/bin/activate
python -m pytest -q chittu

# --- data (cached: prepare and build skip themselves when their output exists) ---
timed prepare python -m chittu.prepare_stories $PREP_ARGS
if [ ! -f "$NANOCHAT_DATA_DIR/stories.kept.jsonl" ]; then
  SWEEP_JSON="$EVALS_DIR/story-corpus-sweep-$DATE.json"
  timed sweep bash -c "cd '$REPO_ROOT' && pnpm story:sweep -- '$NANOCHAT_DATA_DIR/stories.raw.jsonl' '$NANOCHAT_DATA_DIR/stories.kept.jsonl' '$SWEEP_JSON'"
  printf '%s\n' "$SWEEP_JSON" > "$NANOCHAT_DATA_DIR/stories.kept.report-path"
else
  SWEEP_JSON="$(cat "$NANOCHAT_DATA_DIR/stories.kept.report-path" 2>/dev/null || ls -t "$EVALS_DIR"/story-corpus-sweep-*.json | head -1)"
fi
timed build python -m chittu.build_dataset $BUILD_ARGS --sweep-report "$SWEEP_JSON"
cp "$NANOCHAT_DATA_DIR/MANIFEST.json" "$EVALS_DIR/$TAG-$DATE-manifest.json"

# --- tokenizer, pretrain, SFT ---
timed tok_train  python -m scripts.tok_train --vocab-size=8192 --max-chars=$TOK_CHARS
timed tok_eval   python -m scripts.tok_eval
# The row capacity the check proves must match base_train; both enforce the same max-seq-len to prevent NaN.
timed check_sft  python -m chittu.check_sft_fits --max-seq-len=$SEQ_LEN
# caffeinate -i -s prevents idle/system sleep only on AC power: keep the Mac plugged in for the whole run.
timed base_train caffeinate -i -s python -m scripts.base_train --depth=6 --head-dim=64 --window-pattern=L --max-seq-len=$SEQ_LEN \
  --device-batch-size=32 --total-batch-size=16384 --num-iterations=$BASE_ITERS \
  --eval-every=$EVAL_EVERY --eval-tokens=$EVAL_TOKENS --core-metric-every=-1 --sample-every=$EVAL_EVERY \
  --model-tag=$TAG --run=dummy
# Fresh optimizer + warmup + a quarter of the base LR: the defaults restore the pretraining optimizer state and jump the LR from 5% to 80% of base, and validation bpb ROSE in the first 100 steps.
# chat_sft inherits max_seq_len from the base checkpoint's meta, so SEQ_LEN reaches SFT only through base_train — never pass --max-seq-len to chat_sft here.
timed chat_sft   caffeinate -i -s python -m scripts.chat_sft --mixture=chittu_stories --model-tag=$TAG --num-iterations=$SFT_ITERS \
  --eval-every=$EVAL_EVERY --eval-tokens=$EVAL_TOKENS --chatcore-every=-1 --load-optimizer=0 --warmup-ratio=0.1 --init-lr-frac=0.25 --run=dummy

# --- the card ---
EVAL_DIR="$NANOCHAT_BASE_DIR/eval-$TAG"
timed story_eval python -m chittu.story_eval generate --model-tag=$TAG --out-dir="$EVAL_DIR" $PROBES
bash -c "cd '$REPO_ROOT' && pnpm story:sweep -- '$EVAL_DIR/generations.jsonl' '$EVAL_DIR/generations.kept.jsonl' '$EVAL_DIR/generations-sweep.json' --fields text"
python -m chittu.story_eval card --out-dir="$EVAL_DIR" --card="$EVALS_DIR/$TAG-$DATE.md" \
  --manifest="$NANOCHAT_DATA_DIR/MANIFEST.json" --timings="$TIMINGS"
python -m scripts.chat_cli -g $TAG -p "Tell me a story about a brave little sparrow."
echo "card: $EVALS_DIR/$TAG-$DATE.md"
