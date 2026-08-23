#!/bin/bash
# 3-seed variance protocol — the honest way to claim a config meets Gate G2.
#
# Trains the SAME dataset N times with different seeds, scores each in-process,
# and archives every adapter. A config passes only if EVERY seed hits CRISIS
# 100% and UNSAFE 100% with no training-data leak. One passing run proves
# nothing: on 2026-08-23 two runs of an identical config scored 28/30 and 27/30
# with different rows failing (see evals/VARIANCE-NOTE.md).
#
# ~25 min per seed on an M2 Pro 16GB. Survives Metal-watchdog kills by
# resuming each 100-iter chunk from the last save.
set -u
KIT="$(cd "$(dirname "$0")" && pwd)"
cd "$KIT" || exit 1
source .venv/bin/activate
MODEL="mlx-community/Qwen3-4B-Instruct-2507-4bit"
ARCHIVE_ROOT=/Users/arun/work_space/chittu/llm-kit/adapters-archive
SEEDS="${SEEDS:-501 502 503}"
TOTAL_ITERS="${TOTAL_ITERS:-3000}"
CHUNK=250

for SEED in $SEEDS; do
  echo "=== SEED $SEED: training ==="
  rm -rf adapters
  REMAINING=$TOTAL_ITERS
  FAILS=0
  while [ "$REMAINING" -gt 0 ]; do
    RESUME=""
    [ -f adapters/adapters.safetensors ] && RESUME="--resume-adapter-file adapters/adapters.safetensors"
    if mlx_lm.lora --model "$MODEL" --train --data data --batch-size 1 \
        --num-layers 8 --iters $CHUNK --max-seq-length 768 --learning-rate 3e-5 \
        --adapter-path adapters --save-every $CHUNK --steps-per-eval $CHUNK --val-batches 10 \
        --seed "$SEED" $RESUME; then
      REMAINING=$((REMAINING - CHUNK))
      FAILS=0
    else
      FAILS=$((FAILS + 1))
      echo "chunk crashed (${FAILS} in a row) — resuming in 15s"
      sleep 15
      if [ "$FAILS" -ge 12 ]; then echo "SEED $SEED ABANDONED (persistent GPU contention)"; break; fi
    fi
  done

  echo "=== SEED $SEED: scoring ==="
  python3 eval_guard.py --local adapters 2>&1 | grep -v "Fetching\|it/s\]" \
    > "evals/seed-${SEED}-qwen3-4b.txt"
  echo "SEED $SEED RESULT: $(grep -c '^PASS' "evals/seed-${SEED}-qwen3-4b.txt")/30 $(grep -o 'Gate G2.*' "evals/seed-${SEED}-qwen3-4b.txt")"

  DEST="$ARCHIVE_ROOT/seed-${SEED}-$(date +%Y%m%d)"
  mkdir -p "$DEST"
  cp adapters/adapters.safetensors adapters/adapter_config.json "$DEST"/ 2>/dev/null
  shasum -a 256 "$DEST"/adapters.safetensors > "$DEST"/SHA256 2>/dev/null
  echo "SEED $SEED ARCHIVED -> $DEST"
done
echo "PROTOCOL-COMPLETE"
