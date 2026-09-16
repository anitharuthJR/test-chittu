"""
Prove that every SFT pair fits nanochat's packer, with the REAL tokenizer.

  python -m chittu.check_sft_fits [--max-seq-len 512]

nanochat's SFT dataloader (scripts/chat_sft.py, best-fit packing into rows of
max_seq_len + 1 tokens) never places a conversation longer than a row. Enough of them
saturate its 100-conversation buffer, an empty row becomes pure padding with every
target masked, and the loss is NaN — the weights are gone from that step on. It happened
at step 138 of two runs before the cap in build_dataset.py existed. The cap is by
characters (the tokenizer does not exist yet when the dataset is built); this check runs
after tok_train and is the proof that the cap held. It exits non-zero naming the first
pair that does not fit — a training run must not start on data that can NaN.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from chittu.common import data_dir, read_jsonl


def first_overflow(lengths: list[int], capacity: int) -> int | None:
    """Index of the first rendered conversation longer than `capacity` tokens, or None."""
    for i, n in enumerate(lengths):
        if n > capacity:
            return i
    return None


def render_lengths(tokenizer, path: Path) -> list[int]:
    """Token length of every conversation in a JSONL file, rendered exactly as SFT renders it."""
    lengths: list[int] = []
    for conversation in read_jsonl(path):
        ids, _mask = tokenizer.render_conversation(conversation)
        lengths.append(len(ids))
    return lengths


def check(tokenizer, *, max_seq_len: int) -> int:
    """Render both SFT splits; return the longest, or SystemExit naming the first overflow."""
    capacity = max_seq_len + 1
    longest = 0
    for split in ("train", "val"):
        path = data_dir() / f"stories.sft.{split}.jsonl"
        lengths = render_lengths(tokenizer, path)
        bad = first_overflow(lengths, capacity)
        if bad is not None:
            raise SystemExit(
                f"stories.sft.{split}.jsonl: pair {split}[{bad}] renders to {lengths[bad]} tokens, "
                f"over the packer's row capacity of {capacity}. Rebuild with a lower --sft-max-chars "
                f"(chittu/build_dataset.py --force); training on this would NaN."
            )
        longest = max(longest, max(lengths, default=0))
        print(f"stories.sft.{split}.jsonl: {len(lengths)} pairs, max {max(lengths, default=0)} tokens (capacity {capacity})")
    print(f"sft pairs fit: max {longest} <= {capacity}")
    return longest


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="prove every SFT pair fits nanochat's packer")
    p.add_argument("--max-seq-len", type=int, default=512, help="the pretrain/SFT --max-seq-len (row capacity is this + 1)")
    args = p.parse_args(argv)
    from nanochat.tokenizer import get_tokenizer  # the trained tokenizer under $NANOCHAT_BASE_DIR/tokenizer

    check(get_tokenizer(), max_seq_len=args.max_seq_len)
    return 0


if __name__ == "__main__":
    sys.exit(main())
