#!/usr/bin/env python
"""
The story comparison, end to end. argv only; logic lives in compare/.

  generate  -> <out>/<system>/generations.jsonl + <out>/meta.json
  sweep     -> pnpm story:sweep per system (kept.jsonl, sweep.json, sweep.md, verdicts.jsonl)
  blind     -> <out>/human-read/{A..}.md, key.json, FINDINGS.md
  card      -> comparisons/cards/story-vs-tinystories-<date>.{json,md}   (refuses on the instrument check)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from compare import blind, card, contamination, generate, hygiene, prompts, systems
from compare.io_utils import read_jsonl
from compare.paths import REPO_ROOT


def _git_head() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, check=True, capture_output=True, text=True).stdout.strip()


def cmd_generate(a) -> int:
    specs = [systems.by_id(s) for s in a.systems.split(",")] if a.systems else list(systems.REGISTRY)
    loaded = []
    for spec in specs:
        print(f"loading {spec.id} @ {spec.revision[:7]}", file=sys.stderr)
        loaded.append(systems.load_system(spec))
    seeds = tuple(int(s) for s in a.seeds.split(","))
    meta = generate.run_generate(loaded, prompts.load_completion_prompts(), prompts.load_requests(), Path(a.out), seeds=seeds, limit=a.limit)
    for sid, m in meta["systems"].items():
        print(f"{sid}: {m['counts']}")
    return 0


def cmd_sweep(a) -> int:
    out = Path(a.out)
    meta = json.loads((out / "meta.json").read_text())
    for sid in meta["systems"]:
        rep = hygiene.run_sweep(out / sid)
        print(f"{sid}: {rep['kept']} kept of {rep['total']}")
    return 0


def cmd_blind(a) -> int:
    human = blind.make_blind(Path(a.out), seed=a.seed, per_system=a.per_system)
    print(f"blind sample written to {human}; read every lettered file, fill FINDINGS.md, then run `card --human-read {human / 'FINDINGS.md'}`")
    return 0


def cmd_card(a) -> int:
    out = Path(a.out)
    meta = json.loads((out / "meta.json").read_text())
    gens, verds, reps, folds = {}, {}, {}, {}
    for sid in meta["systems"]:
        d = out / sid
        gens[sid] = read_jsonl(d / "generations.jsonl")
        verds[sid] = read_jsonl(d / "verdicts.jsonl")
        reps[sid] = json.loads((d / "sweep.json").read_text())
        hygiene.check_instrument(reps[sid], gens[sid], verds[sid])
        folds[sid] = hygiene.fold(gens[sid], verds[sid])
    contam = None
    if not a.skip_contamination:
        needles = prompts.load_completion_prompts() + prompts.load_requests()
        contam = contamination.check(needles, contamination.corpus_path())
    human = human_text = None
    if a.human_read:
        human = blind.read_findings(Path(a.human_read))
        if human is None:
            raise SystemExit(f"{a.human_read} is blank; the card keeps humanRead null until a person fills it")
        key = json.loads((Path(a.human_read).parent / "key.json").read_text())
        labels = {sid: m["label"] for sid, m in meta["systems"].items()}
        human = {**human, "findings": blind.unblind(human["findings"], key, labels)}
        human_text = human["findings"]
    date = a.date or meta["date"]
    c = card.build_card(meta, folds, date=date, commit=a.commit or _git_head(), human=human, contamination=contam)
    problems = card.validate(c)
    if problems:
        raise SystemExit("card invalid: " + "; ".join(problems))
    json_path, md_path = card.card_paths(date)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(c, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(card.render_md(c, meta, gens, verds, reps, contam, human_text), encoding="utf-8")
    print(f"card: {json_path}\n      {md_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="the story comparison, end to end")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate"); g.add_argument("--out", required=True); g.add_argument("--systems", default=None)
    g.add_argument("--limit", type=int, default=None); g.add_argument("--seeds", default=",".join(str(s) for s in systems.DECODING["seeds"]))
    g.set_defaults(fn=cmd_generate)
    s = sub.add_parser("sweep"); s.add_argument("--out", required=True); s.set_defaults(fn=cmd_sweep)
    b = sub.add_parser("blind"); b.add_argument("--out", required=True); b.add_argument("--seed", type=int, default=7)
    b.add_argument("--per-system", type=int, default=10); b.set_defaults(fn=cmd_blind)
    c = sub.add_parser("card"); c.add_argument("--out", required=True); c.add_argument("--date", default=None)
    c.add_argument("--human-read", default=None); c.add_argument("--skip-contamination", action="store_true")
    c.add_argument("--commit", default=None); c.set_defaults(fn=cmd_card)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
