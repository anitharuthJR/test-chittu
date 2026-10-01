"""Probe (a) completions and probe (b) requests, for every system that takes them, every seed."""
from __future__ import annotations

import json
import platform
from datetime import date
from pathlib import Path

from .io_utils import write_jsonl
from .prompts import PROMPTS_SOURCE_NAME, REQUESTS_PATH, instruct_prompt
from .systems import DECODING, SystemSpec


def generation_id(system_id: str, probe: str, index: int, seed: int) -> str:
    return f"{system_id}:{probe}:{index}:{seed}"


def adapted_prompt(spec: SystemSpec, probe: str, text: str) -> str | None:
    """What the model actually saw when it differs from what the child typed."""
    return instruct_prompt(text) if (probe == "requests" and spec.kind == "gptneo") else None


def _versions() -> dict:
    out = {"python": platform.python_version()}
    for name in ("torch", "transformers"):
        try:
            out[name] = __import__(name).__version__
        except Exception:  # noqa: BLE001 - a missing optional import is just "absent" in meta
            out[name] = None
    return out


def run_generate(systems, prompts: list[str], requests: list[str], out_dir: Path, *,
                 seeds=DECODING["seeds"], limit: int | None = None) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    prompts = prompts[:limit] if limit else prompts
    requests = requests[:limit] if limit else requests
    meta: dict = {
        "date": date.today().isoformat(),
        "decoding": {**DECODING, "seeds": list(seeds)},
        "prompts": {
            "completion": {"count": len(prompts), "source": f"TinyStories '{PROMPTS_SOURCE_NAME}' (sha256-pinned in chittu/SOURCES.json)"},
            "requests": {"count": len(requests), "source": str(REQUESTS_PATH.relative_to(REQUESTS_PATH.parents[3]))},
        },
        "systems": {},
        "versions": _versions(),
    }
    for system in systems:
        spec: SystemSpec = system.spec
        rows: list[dict] = []
        counts: dict[str, int] = {}
        for probe, items, fn in (("completion", prompts, system.complete), ("requests", requests, system.request)):
            if probe not in spec.probes:
                continue
            for index, text in enumerate(items):
                for seed in seeds:
                    g = fn(text, seed)
                    rows.append({
                        "id": generation_id(spec.id, probe, index, seed), "system": spec.id, "probe": probe,
                        "index": index, "seed": seed, "prompt": text, "adapted": adapted_prompt(spec, probe, text),
                        "text": g.text, "chars": len(g.text), "ended": g.ended,
                    })
                    counts[probe] = counts.get(probe, 0) + 1
        write_jsonl(out_dir / spec.id / "generations.jsonl", rows)
        meta["systems"][spec.id] = {
            "label": spec.label, "is_chittu": spec.is_chittu, "source": spec.source, "revision": spec.revision,
            "params": system.params, "probes": list(spec.probes), "notes": spec.notes, "counts": counts,
        }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta
