"""
The scorecard. Two probes, three numbers, every generation verbatim, the human read blank.

  python -m chittu.story_eval generate --model-tag T --out-dir D [--max-completion N --max-requests N]
      -> D/generations.jsonl   {probe, index, prompt, text}
      -> D/eval-meta.json      what the card needs to know about the run
  (the recipe then runs: pnpm story:sweep -- D/generations.jsonl D/generations.kept.jsonl D/generations-sweep.json --fields text)
  python -m chittu.story_eval card --out-dir D --card PATH --manifest M --timings T
      -> PATH                  the Markdown card

Probe (a): the BASE checkpoint completes the paper's 44 prompts. Probe (b): the SFT
checkpoint answers chittu/story_requests.txt. Sampling is fixed and printed on the card.
No CORE, no ChatCORE: they measure general knowledge a kids-story model has no business
having. THE CARD IS THE ARTEFACT; the summary line is a convenience.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from chittu.common import base_dir, data_dir, ensure_source, read_jsonl, write_jsonl

HERE = Path(__file__).resolve().parent
REQUESTS_PATH = HERE / "story_requests.txt"
SAMPLING = {"temperature": 0.6, "top_k": 50, "seed": 42, "max_tokens": 400}
COMPLETION_TOKENS = 200


def load_eval_prompts(path: Path) -> list[str]:
    """
    The paper's prompts file is a YAML list of `- |-` block scalars, two-space indented.
    Parsed here without PyYAML (not a nanochat dependency); the file is sha256-pinned, so
    its shape cannot drift silently.
    """
    prompts: list[str] = []
    current: list[str] | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.strip() == "---":
            continue
        if raw.startswith("- |-"):
            if current is not None:
                prompts.append("\n".join(current).strip("\n"))
            current = []
        elif current is not None:
            current.append(raw[2:] if raw.startswith("  ") else raw)
    if current is not None:
        prompts.append("\n".join(current).strip("\n"))
    return [p for p in prompts if p]


def load_requests(path: Path = REQUESTS_PATH) -> list[str]:
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]


def request_tokens(tokenizer, text: str) -> list[int]:
    """Exactly how scripts/chat_cli.py opens a turn: bos, user_start, text, user_end, assistant_start."""
    return [
        tokenizer.get_bos_token_id(),
        tokenizer.encode_special("<|user_start|>"),
        *tokenizer.encode(text),
        tokenizer.encode_special("<|user_end|>"),
        tokenizer.encode_special("<|assistant_start|>"),
    ]


def completion_tokens(tokenizer, text: str) -> list[int]:
    return [tokenizer.get_bos_token_id(), *tokenizer.encode(text)]


def strip_stops(ids: list[int], stop_ids: set[int]) -> list[int]:
    """Drop the special tokens the engine may sample to end a row; they are not text."""
    return [t for t in ids if t not in stop_ids]


def generate_text(engine, tokenizer, tokens: list[int], *, max_tokens: int, stop_ids: set[int]) -> str:
    ids: list[int] = []
    for token_column, _masks in engine.generate(
        tokens, num_samples=1, max_tokens=max_tokens, temperature=SAMPLING["temperature"], top_k=SAMPLING["top_k"], seed=SAMPLING["seed"]
    ):
        ids.append(token_column[0])
    return tokenizer.decode(strip_stops(ids, stop_ids))


def _load(source: str, model_tag: str, device_type: str):
    from nanochat.checkpoint_manager import load_model
    from nanochat.common import autodetect_device_type, compute_init

    device_type = device_type or autodetect_device_type()
    _ddp, _rank, _local_rank, _world_size, device = compute_init(device_type)
    model, tokenizer, meta = load_model(source, device, phase="eval", model_tag=model_tag)
    return model, tokenizer, meta, device_type


def generate(model_tag: str, out_dir: Path, *, device_type: str = "", max_completion: int = 0, max_requests: int = 0) -> dict:
    from nanochat.common import COMPUTE_DTYPE, compute_cleanup
    from nanochat.engine import Engine

    out_dir.mkdir(parents=True, exist_ok=True)
    prompts = load_eval_prompts(ensure_source("Evaluation prompts.yaml"))
    if len(prompts) != 44:
        raise SystemExit(f"expected the paper's 44 evaluation prompts, parsed {len(prompts)}")
    requests = load_requests()
    if max_completion:
        prompts = prompts[:max_completion]
    if max_requests:
        requests = requests[:max_requests]
    rows: list[dict] = []
    meta: dict = {"model_tag": model_tag, "sampling": SAMPLING, "completion_tokens": COMPLETION_TOKENS, "dtype": str(COMPUTE_DTYPE), "date": date.today().isoformat()}

    model, tokenizer, base_meta, device_type = _load("base", model_tag, device_type)
    meta["device_type"] = device_type
    meta["base"] = {"step": base_meta.get("step"), "val_bpb": base_meta.get("val_bpb"), "model_config": base_meta.get("model_config"), "user_config": base_meta.get("user_config")}
    stop_ids = {tokenizer.get_bos_token_id(), tokenizer.encode_special("<|assistant_end|>")}
    engine = Engine(model, tokenizer)
    for i, prompt in enumerate(prompts):
        text = generate_text(engine, tokenizer, completion_tokens(tokenizer, prompt), max_tokens=COMPLETION_TOKENS, stop_ids=stop_ids)
        rows.append({"probe": "completion", "index": i, "prompt": prompt, "text": text})
        print(f"completion {i + 1}/{len(prompts)}", file=sys.stderr)

    model, tokenizer, sft_meta, _ = _load("sft", model_tag, device_type)
    meta["sft"] = {"step": sft_meta.get("step"), "val_bpb": sft_meta.get("val_bpb")}
    engine = Engine(model, tokenizer)
    for i, req in enumerate(requests):
        text = generate_text(engine, tokenizer, request_tokens(tokenizer, req), max_tokens=SAMPLING["max_tokens"], stop_ids=stop_ids)
        rows.append({"probe": "request", "index": i, "prompt": req, "text": text})
        print(f"request {i + 1}/{len(requests)}", file=sys.stderr)

    meta["probes"] = {"completion": len(prompts), "request": len(requests)}
    write_jsonl(out_dir / "generations.jsonl", rows)
    with open(out_dir / "eval-meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, sort_keys=True)
    compute_cleanup()
    return meta


def _pct(n: int, total: int) -> str:
    return "0.00" if total == 0 else f"{100.0 * n / total:.2f}"


def _na(value: object) -> object:
    """A field that is present but None is a missing input: it prints as n/a, never as None."""
    return "n/a" if value is None else value


def hygiene(sweep: dict | None) -> dict:
    """L1-clean is over all generations; L6-clean is over the L1-clean ones (L1 fires first)."""
    if not sweep:
        return {"available": False}
    total = sweep["total"]
    l1 = {k: v for k, v in sweep["dropped"].items() if k.startswith("L1:")}
    l1_hits = sum(l1.values())
    l6 = sweep["dropped"].get("L6", 0)
    return {
        "available": True,
        "total": total,
        "l1_hits": l1_hits,
        "l1_by_kind": l1,
        "l6_fails": l6,
        "l1_clean_pct": _pct(total - l1_hits, total),
        "l6_clean_pct": _pct(total - l1_hits - l6, total - l1_hits),
    }


def render_card(meta: dict, generations: list[dict], sweep: dict | None, manifest: dict, timings: dict) -> str:
    base, sft = meta.get("base") or {}, meta.get("sft") or {}
    cfg = base.get("model_config") or {}
    h = hygiene(sweep)
    L: list[str] = [
        f"# Story model scorecard — {meta['model_tag']} — {meta['date']}",
        "",
        "Milestone 1, Mac only. This card clears NONE of the gates in `docs/chittu-status.md` §6f: it is the pipeline's proof and M2's first data point. **The card is the artefact; the summary line is a convenience.**",
        "",
        "## Config",
        "",
        "| key | value |",
        "|---|---|",
        f"| nanochat upstream | `{manifest.get('nanochat_upstream', 'n/a')}` |",
        f"| model tag | `{meta['model_tag']}` |",
        f"| depth / vocab / seq len | {cfg.get('n_layer', 'n/a')} / {cfg.get('vocab_size', 'n/a')} / {cfg.get('sequence_len', 'n/a')} |",
        f"| pretrain steps · val_bpb | {_na(base.get('step'))} · {_na(base.get('val_bpb'))} |",
        f"| SFT steps · val_bpb | {_na(sft.get('step'))} · {_na(sft.get('val_bpb'))} |",
        f"| dataset_sha256 | `{manifest.get('dataset_sha256', 'n/a')}` |",
        f"| corpus counts | {json.dumps(x) if (x := manifest.get('counts')) is not None else 'n/a'} |",
        f"| corpus sweep | {json.dumps(x) if (x := manifest.get('sweep')) is not None else 'n/a'} |",
        f"| wall clock (s) | {json.dumps(timings) if timings else 'n/a'} |",
        f"| sampling | {json.dumps(meta['sampling'])}; completion max {meta.get('completion_tokens', 'n/a')} tokens |",
        f"| device · dtype | {meta.get('device_type', 'n/a')} · {meta.get('dtype', 'n/a')} |",
        "",
    ]
    if h["available"]:
        L += ["## Summary line (convenience)", "", f"val_bpb (base) = {_na(base.get('val_bpb'))} · L1-clean = {h['l1_clean_pct']}% · L6-clean = {h['l6_clean_pct']}% (of {h['total']} generations)", ""]
    L += ["## Generations", ""]
    for probe, title in (("completion", "(a) completion — base checkpoint, the paper's prompts"), ("request", "(b) requests — SFT checkpoint, written as a child types")):
        L += [f"### {title}", ""]
        for g in [g for g in generations if g["probe"] == probe]:
            L += [f"#### {probe} {g['index'] + 1}", "", "**Prompt:**", "", "```text", g["prompt"], "```", "", "**Output:**", "", "```text", g["text"], "```", ""]
    L += ["## Generation hygiene", ""]
    if h["available"]:
        L += [
            "`pnpm story:sweep --fields text` over generations.jsonl — the same two gates as the child's screen.",
            "",
            "| generations | L1 hits | L6 fails | L1-clean % | L6-clean % (of L1-clean) |",
            "|---:|---:|---:|---:|---:|",
            f"| {h['total']} | {h['l1_hits']} | {h['l6_fails']} | {h['l1_clean_pct']} | {h['l6_clean_pct']} |",
            "",
            "L1 hits by kind: " + ", ".join(f"{k} {v}" for k, v in h["l1_by_kind"].items()),
            "",
        ]
    else:
        L += ["_No sweep report was supplied; the hygiene numbers are absent, not zero._", ""]
    L += [
        "## Human read",
        "",
        "_Left blank for a person. Read every request output and ten completions; write what you read, the date and your name. A script must not fill this in._",
        "",
        "- Reviewer:",
        "- Date:",
        "- Coherent (stays one story, characters persist)?",
        "- Vocabulary a 4-year-old knows?",
        "- Follows the request (words / topic)?",
        "- Reaches an ending?",
        "- Anything that should never reach a child, even though both gates passed?",
        "",
    ]
    return "\n".join(L)


def card(out_dir: Path, card_path: Path, manifest_path: Path, timings_path: Path) -> None:
    meta = json.loads((out_dir / "eval-meta.json").read_text(encoding="utf-8"))
    generations = list(read_jsonl(out_dir / "generations.jsonl"))
    sweep_path = out_dir / "generations-sweep.json"
    sweep = json.loads(sweep_path.read_text(encoding="utf-8")) if sweep_path.exists() else None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    timings = json.loads(timings_path.read_text(encoding="utf-8")) if timings_path.exists() else {}
    card_path.parent.mkdir(parents=True, exist_ok=True)
    card_path.write_text(render_card(meta, generations, sweep, manifest, timings), encoding="utf-8")
    print(f"card: {card_path}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="story model scorecard")
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="run the two probes")
    g.add_argument("--model-tag", required=True)
    g.add_argument("--out-dir", type=Path, required=True)
    g.add_argument("--device-type", default="", choices=["", "cuda", "cpu", "mps"])
    g.add_argument("--max-completion", type=int, default=0, help="cap probe (a) (smoke runs)")
    g.add_argument("--max-requests", type=int, default=0, help="cap probe (b) (smoke runs)")
    c = sub.add_parser("card", help="render the card from generations + sweep + manifest + timings")
    c.add_argument("--out-dir", type=Path, required=True)
    c.add_argument("--card", type=Path, required=True)
    c.add_argument("--manifest", type=Path, default=data_dir() / "MANIFEST.json")
    c.add_argument("--timings", type=Path, default=base_dir() / "timings.json")
    a = p.parse_args(argv)
    if a.cmd == "generate":
        generate(a.model_tag, a.out_dir, device_type=a.device_type, max_completion=a.max_completion, max_requests=a.max_requests)
    else:
        card(a.out_dir, a.card, a.manifest, a.timings)
    return 0


if __name__ == "__main__":
    sys.exit(main())
