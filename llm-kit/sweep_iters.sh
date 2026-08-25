#!/bin/bash
# Seed 1 of the post-rebalance round, doubling as the iteration sweep.
#
# WHY A SWEEP AND NOT A FIXED 3000. The 500/1500/3000 probe on the OLD corpus
# showed every length broken its own way — undertrained, over-firing on English,
# over-firing on Tamil plus degenerate output. The optimum also moves when the
# corpus changes size, and this corpus went from 5018 to 6392 training rows. So
# the length is measured, not inherited.
#
# Scores at 500/1000/1500/2000 and archives each adapter, so the best point can
# be re-run for seeds 2 and 3 without retraining seed 1.
set -u
# CHITTU_KIT survives the re-exec below. Without it the snapshot recomputes
# KIT from its own temp path and cds into /var/folders, where there is no
# .venv and no data/ — which is what happened the first time.
KIT="${CHITTU_KIT:-$(cd "$(dirname "$0")" && pwd)}"
cd "$KIT" || exit 1

# Immutable for the run — see variance_protocol.sh. Editing a script bash is
# reading by byte offset is how "28/30" survived a fix for hours.
if [ "${CHITTU_SWEEP_PINNED:-}" != "1" ]; then
  SNAP="$(mktemp -t chittu-sweep)"; cat "$0" > "$SNAP"
  export CHITTU_SWEEP_PINNED=1 CHITTU_KIT="$KIT"
  trap "rm -f '$SNAP'" EXIT
  exec bash "$SNAP" "$@"
fi

source .venv/bin/activate

# PIN THE CORPUS FOR THE WHOLE RUN.
#
# On 2026-08-25 this sweep trained chunks 1-2 on the rebalanced corpus and
# everything after on the old one, because a `git checkout` in the same worktree
# — done to split an unrelated PR — rewrote data/train.jsonl underneath it at
# 02:31:50. Nothing complained. The scorecards looked like a model with an
# incoherent Tamil policy; they were a model trained on two different corpora.
#
# Training reads data/ on every chunk, so a run is only meaningful if data/ is
# constant across it. This makes that checkable instead of remembered.
CORPUS_SHA="$(shasum -a 256 data/train.jsonl data/valid.jsonl | shasum -a 256 | cut -d" " -f1)"
echo "CORPUS $CORPUS_SHA"

corpus_unchanged() {
  local now
  now="$(shasum -a 256 data/train.jsonl data/valid.jsonl | shasum -a 256 | cut -d" " -f1)"
  [ "$now" = "$CORPUS_SHA" ] && return 0
  echo "!! CORPUS CHANGED MID-RUN — was $CORPUS_SHA now $now"
  echo "!! Every chunk after this point would train on different data."
  echo "!! Stopping. Results so far are NOT comparable to results after."
  return 1
}

MODEL="mlx-community/Qwen3-4B-Instruct-2507-4bit"
SEED="${SEED:-921}"
CHUNK=250
STOPS="${STOPS:-500 1000 1500 2000}"

rm -rf adapters
done_iters=0
for target in $STOPS; do
  while [ "$done_iters" -lt "$target" ]; do
    corpus_unchanged || exit 3
    RESUME=""
    [ -f adapters/adapters.safetensors ] && RESUME="--resume-adapter-file adapters/adapters.safetensors"
    if mlx_lm.lora --model "$MODEL" --train --data data --batch-size 1 \
        --num-layers 8 --iters $CHUNK --max-seq-length 768 --learning-rate 3e-5 \
        --adapter-path adapters --save-every $CHUNK --steps-per-eval $CHUNK \
        --val-batches 10 --seed "$SEED" $RESUME; then
      done_iters=$((done_iters + CHUNK))
    else
      echo "chunk crashed — resuming in 15s"; sleep 15
    fi
  done

  CARD="evals/parity-seed${SEED}-${target}iter.txt"
  echo "=== scoring seed $SEED at $target iters ==="
  python3 eval_guard.py --local adapters 2>&1 | grep -v "Fetching\|it/s\]" > "$CARD"
  SCORED=$(grep -cE '^(PASS|FAIL)' "$CARD" 2>/dev/null || true); SCORED=${SCORED:-0}
  PASSED=$(grep -c '^PASS' "$CARD" 2>/dev/null || true); PASSED=${PASSED:-0}
  if [ "$SCORED" -eq 0 ]; then
    echo "SWEEP $target: !! NO ROWS SCORED — harness failure, not a model result:"
    sed 's/^/    | /' "$CARD" | head -5
  else
    echo "SWEEP $target: $PASSED/$SCORED"
    sed -n '/===== SCORE =====/,/-----/p' "$CARD" | grep -E "CRISIS|UNSAFE|SAFE|SPINE|PII" | sed 's/^/    /'
    echo "    tamil SAFE controls:"
    grep -E "enakku kanaku pidikkum|nilavu eppadi minnuthu" "$CARD" | sed 's/^/      /'
    echo "    tamil crisis:"
    grep -E "sakanum|saaka venum|saagavenum|vaazhkai venam" "$CARD" | sed 's/^/      /'
    echo "    degenerate replies: $(grep -cE '(.)\1{19,}' "$CARD" || true)"
  fi
  DEST="adapters-archive/parity-seed${SEED}-${target}iter"
  mkdir -p "$DEST"; cp adapters/adapters.safetensors adapters/adapter_config.json "$DEST"/ 2>/dev/null
done
echo "SWEEP-COMPLETE"
