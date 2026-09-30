"""Never train on eval prompts — and prove it, or say the proof did not run."""
from __future__ import annotations

import json
from pathlib import Path

from .paths import ensure_nanochat_on_path


def corpus_path() -> Path:
    ensure_nanochat_on_path()
    from chittu.common import data_dir
    return data_dir() / "stories.kept.jsonl"


def check(needles: list[str], corpus: Path, field: str = "story") -> dict:
    corpus = Path(corpus)
    if not corpus.exists():
        return {"status": "not run", "reason": f"{corpus} is absent on this machine"}
    hits: dict[str, list[str]] = {}
    n = 0
    with open(corpus, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            n += 1
            text = rec.get(field, "")
            for needle in needles:
                if needle in text:
                    hits.setdefault(needle, []).append(str(rec.get("id")))
    return {"status": "run", "records": n, "needles": len(needles), "hits": hits}
