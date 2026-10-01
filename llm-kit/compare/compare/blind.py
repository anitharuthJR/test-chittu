"""
The human read is blind: the reviewer sees lettered systems and a random sample, the key
sits in a separate file, and the card step unblinds only when the findings are filled in.
A script never writes a human judgement (the M1 card's rule).
"""
from __future__ import annotations

import json
import random
import re
import string
from pathlib import Path

from .io_utils import read_jsonl

FINDINGS_TEMPLATE = (
    "reviewer: \n"
    "date: \n"
    "sample_size: \n"
    "\n"
    "<!-- Read every item in every lettered file. Refer to systems as 'System A', 'System B' …\n"
    "     Rubric per item: coherent (one story, characters persist)? vocabulary a 4-year-old knows?\n"
    "     follows the request (requests only)? reaches an ending? anything that should never reach\n"
    "     a child even though both gates passed? Write what you read below this comment. -->\n"
)

_HEADER = ("reviewer", "date", "sample_size")


def make_blind(out_dir: Path, *, seed: int = 7, per_system: int = 10) -> Path:
    out_dir = Path(out_dir)
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    human = out_dir / "human-read"
    human.mkdir(exist_ok=True)
    rng = random.Random(seed)
    letters = iter(string.ascii_uppercase)
    key: dict[str, dict] = {}
    for probe in ("completion", "requests"):
        systems = sorted(s for s, m in meta["systems"].items() if probe in m["probes"])
        rng.shuffle(systems)
        for system in systems:
            letter = next(letters)
            key[letter] = {"system": system, "probe": probe}
            rows = [r for r in read_jsonl(out_dir / system / "generations.jsonl") if r["probe"] == probe]
            sample = rng.sample(rows, min(per_system, len(rows)))
            (human / f"{letter}.md").write_text(_render(letter, probe, sample), encoding="utf-8")
    (human / "key.json").write_text(json.dumps(key, indent=2) + "\n", encoding="utf-8")
    findings = human / "FINDINGS.md"
    if not findings.exists():
        findings.write_text(FINDINGS_TEMPLATE, encoding="utf-8")
    return human


def _render(letter: str, probe: str, sample: list[dict]) -> str:
    parts = [f"# System {letter} — {probe}\n", "Blind sample. Do not open key.json until FINDINGS.md is written.\n"]
    for i, r in enumerate(sample, 1):
        shown = r["adapted"] if r.get("adapted") else r["prompt"]
        parts.append(f"\n### Item {i}\n\n**Prompt**\n\n```text\n{shown}\n```\n\n**Output**\n\n```text\n{r['text']}\n```\n")
    return "".join(parts)


def read_findings(path: Path) -> dict | None:
    text = Path(path).read_text(encoding="utf-8")
    header: dict[str, str] = {}
    body_lines: list[str] = []
    for line in text.splitlines():
        m = re.fullmatch(r"(reviewer|date|sample_size):\s*(.*)", line)
        if m and m.group(1) not in header and not body_lines:
            header[m.group(1)] = m.group(2).strip()
        else:
            body_lines.append(line)
    body = re.sub(r"<!--.*?-->", "", "\n".join(body_lines), flags=re.S).strip()
    filled = [k for k in _HEADER if header.get(k)]
    if not filled and not body:
        return None
    if len(filled) != len(_HEADER) or not body:
        raise ValueError(f"{path}: findings are half-filled (have {filled}, body {'present' if body else 'empty'})")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", header["date"]):
        raise ValueError(f"{path}: date must be ISO, got {header['date']!r}")
    return {"reviewer": header["reviewer"], "date": header["date"], "sample_size": int(header["sample_size"]), "findings": body}


def unblind(text: str, key: dict, labels: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        k = key[m.group(1)]
        return f"{labels[k['system']]} ({k['probe']})"
    return re.sub(r"\bSystem ([A-Z])\b", repl, text)
