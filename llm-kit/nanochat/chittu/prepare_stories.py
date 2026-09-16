"""
Pin, verify, filter — the pre-sweep half of the corpus path.

  TinyStories_all_data.tar.gz --sha256 verified--> stories.raw.jsonl + prepare-report.json

Both outputs land in $NANOCHAT_DATA_DIR. Records are read in ARCHIVE order in a single
streaming pass; the pinned sha256 fixes that order, so the output is reproducible.
Nothing here is a safety gate — the sweep (`pnpm story:sweep`) runs after this and
before chittu/build_dataset.py.

  python -m chittu.prepare_stories [--source GPT-4|GPT-3.5|any] [--drop-features TAG]... [--limit N] [--force]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tarfile
from collections.abc import Iterator
from pathlib import Path

from chittu.common import data_dir, ensure_source, sha256_text, write_jsonl

TAR_NAME = "TinyStories_all_data.tar.gz"
PROMPTS_NAME = "Evaluation prompts.yaml"
REQUIRED = ("story", "instruction", "summary", "source")
REQUIRED_INSTRUCTION = ("words", "features")


def check_schema(rec: object, where: str) -> dict:
    """Every record carries the fields we rely on; a missing one ABORTS, naming the record."""
    if not isinstance(rec, dict):
        raise SystemExit(f"schema: record {where} is not an object")
    for key in REQUIRED:
        if key not in rec:
            raise SystemExit(f"schema: record {where} lacks '{key}'")
    for key in ("story", "summary", "source"):
        if not isinstance(rec[key], str):
            raise SystemExit(f"schema: record {where} has a non-string '{key}'")
    ins = rec["instruction"]
    if not isinstance(ins, dict):
        raise SystemExit(f"schema: record {where} has a non-object 'instruction'")
    for key in REQUIRED_INSTRUCTION:
        if key not in ins or not isinstance(ins[key], list):
            raise SystemExit(f"schema: record {where} lacks 'instruction.{key}' (a list)")
        for j, item in enumerate(ins[key]):
            if not isinstance(item, str):
                raise SystemExit(f"schema: record {where} has a non-string 'instruction.{key}[{j}]'")
    return rec


def iter_records(tar_path: Path) -> Iterator[tuple[str, int, object]]:
    """Yield (member, index, record) in archive order — one streaming pass, no index build."""
    with tarfile.open(tar_path, "r|gz") as tar:
        for member in tar:
            if not member.isfile() or not member.name.endswith(".json"):
                continue
            f = tar.extractfile(member)
            assert f is not None
            records = json.load(f)
            if not isinstance(records, list):
                raise SystemExit(f"schema: member {member.name} is not a JSON array")
            for i, rec in enumerate(records):
                yield member.name, i, rec


def record_id(story: str) -> str:
    return sha256_text(story.strip())[:16]


def prepare(
    tar_path: Path,
    out_path: Path,
    report_path: Path,
    *,
    keep_sources: set[str] | None,
    drop_features: set[str],
    limit: int = 0,
) -> dict:
    counts: dict = {"total": 0, "kept": 0, "dropped_source": 0, "dropped_feature": 0, "dropped_duplicate": 0, "by_source": {}}
    seen: set[str] = set()

    def kept() -> Iterator[dict]:
        for member, i, raw in iter_records(tar_path):
            rec = check_schema(raw, f"{member}[{i}]")
            counts["total"] += 1
            counts["by_source"][rec["source"]] = counts["by_source"].get(rec["source"], 0) + 1
            if keep_sources is not None and rec["source"] not in keep_sources:
                counts["dropped_source"] += 1
                continue
            features = rec["instruction"]["features"]
            if any(f in drop_features for f in features):
                counts["dropped_feature"] += 1
                continue
            rid = record_id(rec["story"])
            if rid in seen:
                counts["dropped_duplicate"] += 1
                continue
            seen.add(rid)
            counts["kept"] += 1
            yield {
                "id": rid,
                "story": rec["story"].strip(),
                "words": rec["instruction"]["words"],
                "features": features,
                "summary": rec["summary"].strip(),
                "source": rec["source"],
            }
            if limit and counts["kept"] >= limit:
                return

    tmp_path = out_path.with_name(out_path.name + ".tmp")
    try:
        write_jsonl(tmp_path, kept())
        report = {
            "tar": tar_path.name,
            "keep_sources": sorted(keep_sources) if keep_sources is not None else "any",
            "drop_features": sorted(drop_features),
            "limit": limit,
            **counts,
        }
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, sort_keys=True)
        os.replace(tmp_path, out_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="TinyStories tarball -> stories.raw.jsonl (pre-sweep)")
    p.add_argument("--source", default="GPT-4", help="keep only this source: GPT-4 (default) | GPT-3.5 | any")
    p.add_argument("--drop-features", action="append", default=None, metavar="TAG", help="drop records tagged TAG; repeatable; default BadEnding")
    p.add_argument("--limit", type=int, default=0, help="stop after N kept records (smoke runs)")
    p.add_argument("--force", action="store_true", help="rebuild even if stories.raw.jsonl exists")
    args = p.parse_args(argv)

    out = data_dir() / "stories.raw.jsonl"
    report = data_dir() / "prepare-report.json"
    if out.exists() and not args.force:
        print(f"{out} exists; skipping (use --force to rebuild)")
        return 0
    data_dir().mkdir(parents=True, exist_ok=True)
    tar_path = ensure_source(TAR_NAME)
    ensure_source(PROMPTS_NAME)  # verified now; story_eval reads it later
    drop = set(args.drop_features) if args.drop_features else {"BadEnding"}
    keep = None if args.source == "any" else {args.source}
    rep = prepare(tar_path, out, report, keep_sources=keep, drop_features=drop, limit=args.limit)
    print(json.dumps(rep, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
