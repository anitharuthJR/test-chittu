"""
Shared helpers for the Chittu story kit: where things live, pinned downloads, hashing,
JSONL. No model code and no nanochat imports, so a test can import this without torch.

Everything the kit writes lives under NANOCHAT_BASE_DIR (default ~/.cache/nanochat-chittu),
never in the git tree.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.request
from collections.abc import Iterable, Iterator
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES_PATH = HERE / "SOURCES.json"


def base_dir() -> Path:
    return Path(os.environ.get("NANOCHAT_BASE_DIR") or os.path.expanduser("~/.cache/nanochat-chittu"))


def data_dir() -> Path:
    """Mirrors the NANOCHAT_DATA_DIR patch in nanochat/dataset.py, with this kit's default."""
    override = os.environ.get("NANOCHAT_DATA_DIR")
    return Path(override) if override else base_dir() / "stories_data"


def sources_dir() -> Path:
    return base_dir() / "sources"


def load_sources() -> dict:
    with open(SOURCES_PATH, encoding="utf-8") as f:
        return json.load(f)


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ensure_source(name: str) -> Path:
    """
    Download a pinned source if it is absent, then verify its sha256 BEFORE anything reads
    it. A mismatch is a SystemExit, not a warning: the hash is the provenance.
    """
    spec = load_sources()["sources"][name]
    dest = sources_dir() / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        tmp = dest.with_name(dest.name + ".tmp")
        print(f"downloading {spec['url']} -> {dest}", file=sys.stderr)
        urllib.request.urlretrieve(spec["url"], tmp)
        os.replace(tmp, dest)
    actual = sha256_file(dest)
    if actual != spec["sha256"]:
        raise SystemExit(
            f"sha256 mismatch for {dest}: expected {spec['sha256']}, got {actual}. "
            "Refusing to read it — delete the file and re-run to download again."
        )
    return dest


def write_jsonl(path: str | Path, records: Iterable[dict]) -> int:
    n = 0
    with open(path, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n


def read_jsonl(path: str | Path) -> Iterator[dict]:
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)
