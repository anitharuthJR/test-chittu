"""
Hygiene = Chittu's real guards over every generation, via the existing sweep.

The instrument check is the point: a sweep that judged fewer texts than were generated, or
whose kept count disagrees with its own verdicts, is an instrument reporting on something
else (docs/chittu-status.md §8b). The card step refuses rather than publishing.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .io_utils import pct
from .paths import REPO_ROOT


class InstrumentError(SystemExit):
    pass


def sweep_command(gens, kept, report, verdicts) -> list[str]:
    return ["pnpm", "story:sweep", "--", str(gens), str(kept), str(report), "--fields", "text", "--verdicts", str(verdicts)]


def run_sweep(system_dir: Path, repo_root: Path = REPO_ROOT) -> dict:
    system_dir = Path(system_dir)
    cmd = sweep_command(system_dir / "generations.jsonl", system_dir / "kept.jsonl",
                        system_dir / "sweep.json", system_dir / "verdicts.jsonl")
    subprocess.run(cmd, cwd=repo_root, check=True)
    return json.loads((system_dir / "sweep.json").read_text(encoding="utf-8"))


def verdict_label(verdict: dict) -> str:
    if verdict["keep"]:
        return "clean"
    return f"L1:{verdict['kind']}" if verdict["gate"] == "L1" else "L6"


def check_instrument(report: dict, generations: list[dict], verdicts: list[dict]) -> None:
    if not (report["total"] == len(generations) == len(verdicts)):
        raise InstrumentError(
            f"instrument check failed: the sweep judged {report['total']} texts, "
            f"{len(generations)} generations were written, {len(verdicts)} verdicts came back"
        )
    kept = sum(1 for v in verdicts if v["keep"])
    if kept != report["kept"]:
        raise InstrumentError(f"instrument check failed: report says {report['kept']} kept, verdicts say {kept}")
    have = {v["id"] for v in verdicts}
    missing = [g["id"] for g in generations if g["id"] not in have]
    if missing:
        raise InstrumentError(f"instrument check failed: no verdict for {missing[:3]}{'…' if len(missing) > 3 else ''}")


def fold(generations: list[dict], verdicts: list[dict]) -> dict[str, dict]:
    by_id = {v["id"]: v for v in verdicts}
    out: dict[str, dict] = {}
    for g in generations:
        v = by_id.get(g["id"])
        if v is None:
            raise InstrumentError(f"no verdict for {g['id']}")
        p = out.setdefault(g["probe"], {"total": 0, "clean": 0, "ended": 0, "by_kind": {}})
        p["total"] += 1
        p["clean"] += 1 if v["keep"] else 0
        p["ended"] += 1 if g["ended"] else 0
        if not v["keep"]:
            key = verdict_label(v)
            p["by_kind"][key] = p["by_kind"].get(key, 0) + 1
    for p in out.values():
        p["clean_pct"] = pct(p["clean"], p["total"])
        p["ended_pct"] = pct(p["ended"], p["total"])
    return out
