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

# RUN FROM A SNAPSHOT OF MYSELF, NOT FROM THE FILE ON DISK.
#
# bash reads a script INCREMENTALLY, by byte offset, as it executes. Edit the
# file mid-run and the running shell reads the new bytes at the old offset —
# which on 2026-08-25 meant a run that had already been fixed to derive its
# denominator kept printing the hardcoded one, and reported round 7 seed 911 as
# "28/30" when the scorecard held 35 rows and 28 passes. 80% read as 93% for
# several hours, in a log written specifically to be trusted.
#
# Re-exec from a copy so the running protocol is immutable for its whole life.
if [ "${CHITTU_PROTOCOL_PINNED:-}" != "1" ]; then
  SNAP="$(mktemp -t chittu-protocol)"
  cat "$0" > "$SNAP"
  export CHITTU_PROTOCOL_PINNED=1
  # shellcheck disable=SC2064
  trap "rm -f '$SNAP'" EXIT
  exec bash "$SNAP" "$@"
fi
source .venv/bin/activate
MODEL="mlx-community/Qwen3-4B-Instruct-2507-4bit"
ARCHIVE_ROOT=/Users/arun/work_space/chittu/llm-kit/adapters-archive
SEEDS="${SEEDS:-701 702 703}"
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
  # Denominator DERIVED from the scorecard, never hardcoded. It read "/30" while
  # the eval was 35 prompts, so every line this printed was wrong by five.
  #
  # The zero-guard matters more. On 2026-08-24 this printed "SEED 901 RESULT:
  # 0/30" and moved on to the next seed — and that 0 was `eval_guard.py: error:
  # unrecognized arguments: --local adapters`, an argparse usage message written
  # into the scorecard file. A scorer that cannot start looks exactly like a
  # model that failed everything, and only one of those is worth retraining for.
  CARD="evals/seed-${SEED}-qwen3-4b.txt"
  # `grep -c` PRINTS 0 and EXITS 1 when there are no matches, so `|| echo 0`
  # appends a second zero and the comparison below dies on "0\n0". || true.
  SCORED=$(grep -cE '^(PASS|FAIL)' "$CARD" 2>/dev/null || true); SCORED=${SCORED:-0}
  PASSED=$(grep -c '^PASS' "$CARD" 2>/dev/null || true); PASSED=${PASSED:-0}
  if [ "$SCORED" -eq 0 ]; then
    echo "SEED $SEED RESULT: !! NO ROWS SCORED — the harness failed, this is not a model result:"
    sed 's/^/    | /' "$CARD" | head -5
  else
    echo "SEED $SEED RESULT: $PASSED/$SCORED $(grep -o 'Gate G2.*' "$CARD")"
  fi

  echo "SEED $SEED SCORECARD: $KIT/$CARD  <- the file is the truth, not the line above"
  DEST="$ARCHIVE_ROOT/seed-${SEED}-$(date +%Y%m%d)"
  mkdir -p "$DEST"
  cp adapters/adapters.safetensors adapters/adapter_config.json "$DEST"/ 2>/dev/null
  shasum -a 256 "$DEST"/adapters.safetensors > "$DEST"/SHA256 2>/dev/null
  echo "SEED $SEED ARCHIVED -> $DEST"
done
echo "PROTOCOL-COMPLETE"
