"""Never train on eval prompts — and prove it, or say the proof did not run."""
from __future__ import annotations

import json
from pathlib import Path

from .paths import ensure_nanochat_on_path


def corpus_path() -> Path:
    ensure_nanochat_on_path()
    from chittu.common import data_dir
    return data_dir() / "stories.kept.jsonl"


def _squash(text: str) -> str:
    """Runs of whitespace become one space: a prompt's blank line between paragraphs is a
    single newline in the corpus, and a raw substring test would call that pair unrelated."""
    return " ".join(text.split())


def check(needles: list[str], corpus: Path, field: str = "story") -> dict:
    corpus = Path(corpus)
    if not corpus.exists():
        return {"status": "not run", "reason": f"{corpus} is absent on this machine"}
    squashed = [(needle, _squash(needle)) for needle in needles]
    hits: dict[str, list[str]] = {}
    n = 0
    with open(corpus, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            n += 1
            text = _squash(rec.get(field, ""))
            for needle, flat in squashed:
                if flat in text:
                    hits.setdefault(needle, []).append(str(rec.get("id")))
    return {"status": "run", "records": n, "needles": len(needles), "hits": hits}
