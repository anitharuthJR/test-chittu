"""
The post-sweep half: stories.kept.jsonl -> what nanochat consumes.

  $NANOCHAT_DATA_DIR/shard_00000.parquet ... shard_NNNNN.parquet   column `text`; the LAST shard is validation
  $NANOCHAT_DATA_DIR/stories.sft.{train,val}.jsonl                  {"messages": [user, assistant]}
  $NANOCHAT_DATA_DIR/MANIFEST.json                                  every hash; dataset_sha256

Runs AFTER `pnpm story:sweep` — it reads the KEPT file only. `--min-train` refuses a corpus
too small for the planned run: a shorter run is a different experiment, not a smaller one.

  python -m chittu.build_dataset [--min-train N] [--sft-max N] [--sft-val-max N] [--val-min N] [--sft-max-chars N] [--sweep-report PATH] [--force]
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections.abc import Iterable
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from chittu.common import data_dir, load_sources, read_jsonl, sha256_file, sha256_text, write_jsonl

SHARD_ROWS = 50_000
ROW_GROUP = 1_000


def split_records(records: Iterable[dict], *, seed: int = 42, val_frac: float = 0.01, val_min: int = 2_000) -> tuple[list[dict], list[dict]]:
    recs = list(records)
    random.Random(seed).shuffle(recs)
    n_val = min(len(recs), max(val_min, int(len(recs) * val_frac)))
    cut = len(recs) - n_val
    return recs[:cut], recs[cut:]


def write_shards(train: list[dict], val: list[dict], out_dir: Path) -> list[Path]:
    """Training shards of SHARD_ROWS, then validation as EXACTLY ONE final shard (nanochat reads the last file as val)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("shard_*.parquet"):
        stale.unlink()
    chunks = [train[i : i + SHARD_ROWS] for i in range(0, len(train), SHARD_ROWS)]
    paths: list[Path] = []
    for idx, chunk in enumerate(chunks + [val]):
        path = out_dir / f"shard_{idx:05d}.parquet"
        pq.write_table(pa.table({"text": [r["story"] for r in chunk]}), path, row_group_size=ROW_GROUP)
        paths.append(path)
    return paths


def render_prompt(rec: dict) -> str:
    """Deterministic per record: <45 the words template (if it has words), <90 the summary, else bare."""
    bucket = int(rec["id"][:8], 16) % 100
    words = [w.strip() for w in rec.get("words", []) if isinstance(w, str) and w.strip()]
    summary = (rec.get("summary") or "").strip()
    if bucket < 45 and words:
        joined = words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]
        return f"Tell me a story using the words {joined}."
    if bucket < 90 and summary:
        return f"Tell me a story about this: {summary}"
    return "Tell me a story."


def to_pair(rec: dict) -> dict:
    return {"messages": [{"role": "user", "content": render_prompt(rec)}, {"role": "assistant", "content": rec["story"]}]}


def sft_pairs(records: list[dict], limit: int, max_chars: int) -> tuple[list[dict], int]:
    """
    Up to `limit` pairs whose prompt + story fit `max_chars`; every record over the cap is counted, whether or not the quota was already full. The cap exists because nanochat's SFT packer never places a conversation longer
    than its 513-token row: enough of them saturate its buffer and a row of pure padding
    makes the masked loss NaN (it happened at step 138, twice). chittu/check_sft_fits.py
    proves, after the tokenizer exists, that every pair really fits.
    """
    pairs: list[dict] = []
    skipped = 0
    for rec in records:
        pair = to_pair(rec)
        if sum(len(m["content"]) for m in pair["messages"]) > max_chars:
            skipped += 1
            continue
        if len(pairs) < limit:
            pairs.append(pair)
    return pairs, skipped


def build(
    kept_path: Path,
    out_dir: Path,
    *,
    min_train: int,
    sft_max: int,
    sft_val_max: int,
    val_min: int,
    seed: int = 42,
    sweep_report: Path | None = None,
    sft_max_chars: int = 1600,
) -> dict:
    train, val = split_records(read_jsonl(kept_path), seed=seed, val_min=val_min)
    if len(train) < min_train:
        raise SystemExit(
            f"only {len(train)} training stories after the sweep; --min-train is {min_train}. "
            "A shorter run is a different experiment — re-plan it, do not run it smaller."
        )
    shard_paths = write_shards(train, val, out_dir)
    sft_train, sft_val = out_dir / "stories.sft.train.jsonl", out_dir / "stories.sft.val.jsonl"
    train_pairs, skipped_train = sft_pairs(train, sft_max, sft_max_chars)
    val_pairs, skipped_val = sft_pairs(val, sft_val_max, sft_max_chars)
    n_sft_train = write_jsonl(sft_train, train_pairs)
    n_sft_val = write_jsonl(sft_val, val_pairs)
    shards = {p.name: sha256_file(p) for p in shard_paths}
    prepare_report = out_dir / "prepare-report.json"
    sweep = json.loads(sweep_report.read_text(encoding="utf-8")) if sweep_report else None
    sources = load_sources()
    manifest = {
        "nanochat_upstream": sources["nanochat_upstream"],
        "sources": sources["sources"],
        "prepare": json.loads(prepare_report.read_text(encoding="utf-8")) if prepare_report.exists() else None,
        "sweep": {k: sweep[k] for k in ("total", "kept", "dropped")} if sweep else None,
        "sweep_report_sha256": sha256_file(sweep_report) if sweep_report else None,
        "split": {"seed": seed, "val_frac": 0.01, "val_min": val_min, "shard_rows": SHARD_ROWS, "row_group": ROW_GROUP, "sft_max_chars": sft_max_chars},
        "counts": {"train": len(train), "val": len(val), "sft_train": n_sft_train, "sft_val": n_sft_val, "sft_skipped_long": skipped_train + skipped_val},
        "shards": shards,
        "sft_files": {sft_train.name: sha256_file(sft_train), sft_val.name: sha256_file(sft_val)},
        "dataset_sha256": sha256_text("\n".join(shards[k] for k in sorted(shards))),
    }
    with open(out_dir / "MANIFEST.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="stories.kept.jsonl -> parquet shards + SFT pairs + MANIFEST.json")
    p.add_argument("--min-train", type=int, default=200_000, help="refuse to build fewer training stories than this")
    p.add_argument("--sft-max", type=int, default=100_000)
    p.add_argument("--sft-val-max", type=int, default=2_000)
    p.add_argument("--val-min", type=int, default=2_000)
    p.add_argument("--sft-max-chars", type=int, default=1600, help="skip SFT pairs (prompt+story) longer than this many characters — nanochat's packer never places a conversation longer than its row")
    p.add_argument("--sweep-report", type=Path, default=None, help="the sweep's report.json; hashed into the MANIFEST")
    p.add_argument("--force", action="store_true", help="rebuild even if MANIFEST.json exists")
    args = p.parse_args(argv)
    out_dir = data_dir()
    manifest_path = out_dir / "MANIFEST.json"
    if manifest_path.exists() and not args.force:
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        existing_cap = (existing.get("split") or {}).get("sft_max_chars")
        if existing_cap is not None and existing_cap != args.sft_max_chars:
            print(f"{manifest_path} exists but was built with --sft-max-chars {existing_cap}; rebuilding with {args.sft_max_chars}")
        else:
            print(f"{manifest_path} exists; skipping (use --force to rebuild)")
            return 0
    kept = out_dir / "stories.kept.jsonl"
    if not kept.exists():
        raise SystemExit(f"{kept} missing — run `pnpm story:sweep` first (see chittu/README.md)")
    manifest = build(kept, out_dir, min_train=args.min_train, sft_max=args.sft_max, sft_val_max=args.sft_val_max, val_min=args.val_min, sft_max_chars=args.sft_max_chars, sweep_report=args.sweep_report)
    print(json.dumps({"counts": manifest["counts"], "dataset_sha256": manifest["dataset_sha256"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
