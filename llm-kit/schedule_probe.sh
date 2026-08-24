#!/bin/bash
# Does the 3000-iteration schedule explain the Tamil failures, or does Tamil?
#
# WHY THIS EXISTS. Round 7 seed 911 scored 28/30 and its Tamil crisis misses
# were not misclassifications — they were degenerate generations (156 identical
# 🥺, an incoherent food reply). Meanwhile validation loss rose monotonically
# from chunk 2 (500 iters, 0.890) to chunk 11 (2750 iters, 1.304) while train
# loss fell 8.6x. Both point at the schedule rather than the language.
#
# But val loss is token-level cross-entropy over whole replies, most of which is
# free-form SAFE prose, while G2 scores one thing: whether the right escalation
# token came out. Those can move in opposite directions. So this is a hypothesis
# with a mechanism, and this script is the test.
#
# THE DESIGN. Same seed, same corpus, same everything except iterations. A
# within-seed comparison, so seed variance — which cost four earlier rounds their
# comparability — cannot explain the difference. The 3000-iter point already
# exists as evals/seed-911-qwen3-4b.txt and adapters-archive/seed-911-20260825.
#
# READ THE RESULT LIKE THIS:
#   SAFE controls pass at 500 and fail at 3000  -> the schedule is the fault.
#     The §7b stopping condition does NOT fire. Re-run the protocol shorter.
#   fail at every length                        -> the schedule is exonerated,
#     the fault is the data or the language, and §7b's stopping condition stands.
set -u
KIT="$(cd "$(dirname "$0")" && pwd)"
cd "$KIT" || exit 1
source .venv/bin/activate
MODEL="mlx-community/Qwen3-4B-Instruct-2507-4bit"
SEED=911
CHUNK=250

train_to() {           # $1 = target total iters, $2 = iters already done
  local target=$1 done=$2
  while [ "$done" -lt "$target" ]; do
    local resume=""
    [ -f adapters/adapters.safetensors ] && resume="--resume-adapter-file adapters/adapters.safetensors"
    if mlx_lm.lora --model "$MODEL" --train --data data --batch-size 1 \
        --num-layers 8 --iters $CHUNK --max-seq-length 768 --learning-rate 3e-5 \
        --adapter-path adapters --save-every $CHUNK --steps-per-eval $CHUNK \
        --val-batches 10 --seed "$SEED" $resume; then
      done=$((done + CHUNK))
    else
      echo "chunk crashed — resuming in 15s"; sleep 15
    fi
  done
}

score_at() {           # $1 = iters, for the filename
  local iters=$1
  local card="evals/schedule-probe-${iters}iter-seed${SEED}.txt"
  echo "=== scoring at ${iters} iters ==="
  python3 eval_guard.py --local adapters 2>&1 | grep -v "Fetching\|it/s\]" > "$card"
  # Denominator derived, never hardcoded; zero-guard because a harness that
  # cannot start looks exactly like a model that failed everything.
  local scored passed
  scored=$(grep -cE '^(PASS|FAIL)' "$card" 2>/dev/null || true); scored=${scored:-0}
  passed=$(grep -c '^PASS' "$card" 2>/dev/null || true); passed=${passed:-0}
  if [ "$scored" -eq 0 ]; then
    echo "PROBE ${iters}: !! NO ROWS SCORED — harness failure, not a model result:"
    sed 's/^/    | /' "$card" | head -5
    return
  fi
  echo "PROBE ${iters}: ${passed}/${scored}"
  echo "  the two Tamil SAFE controls:"
  grep -E "enakku kanaku pidikkum|nilavu eppadi minnuthu" "$card" | sed 's/^/    /'
  echo "  Tamil/Tanglish crisis:"
  grep -E "sakanum|saaka venum|saagavenum|vaazhkai venam" "$card" | sed 's/^/    /'
  # Degeneration is the specific thing under test: a reply that is mostly one
  # repeated emoji is a collapsed generation, not a classification.
  echo "  degenerate replies (>=20 repeats of one char): $(grep -cE '(.)\1{19,}' "$card" || true)"
  local dest="adapters-archive/schedule-probe-${iters}iter-seed${SEED}"
  mkdir -p "$dest"; cp adapters/adapters.safetensors adapters/adapter_config.json "$dest"/ 2>/dev/null
}

rm -rf adapters
train_to 500 0
score_at 500
train_to 1500 500
score_at 1500
echo "PROBE-COMPLETE"
