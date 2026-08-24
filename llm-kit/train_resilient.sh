#!/bin/bash
# Auto-resuming MLX LoRA train — survives macOS Metal watchdog kills.
# Trains in 200-iter chunks, resuming from adapters/adapters.safetensors after
# any crash; --seed varies per chunk so each restart samples fresh examples.
KIT=/Users/arun/work_space/chittu/.claude/worktrees/guard-dataset-v2/llm-kit
cd "$KIT" || exit 1
source .venv/bin/activate
MODEL="mlx-community/Qwen3-4B-Instruct-2507-4bit"
CHUNK=100
REMAINING=1400
seed=400
while [ "$REMAINING" -gt 0 ]; do
  RESUME=""
  [ -f adapters/adapters.safetensors ] && RESUME="--resume-adapter-file adapters/adapters.safetensors"
  echo "CHUNK start (remaining $REMAINING, seed $seed)"
  if mlx_lm.lora --model "$MODEL" --train --data data --batch-size 1 --num-layers 8 \
      --iters $CHUNK --max-seq-length 768 --learning-rate 3e-5 \
      --adapter-path adapters --save-every $CHUNK --steps-per-eval $CHUNK \
      --seed $seed $RESUME; then
    REMAINING=$((REMAINING - CHUNK))
    echo "CHUNK done (remaining $REMAINING)"
  else
    echo "CHUNK CRASHED — resuming from last save in 15s"
    sleep 15
  fi
  seed=$((seed + 1))
done
echo "TRAINING-COMPLETE"
