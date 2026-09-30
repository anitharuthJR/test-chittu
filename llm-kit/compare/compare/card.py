"""
The card is the artefact. build_card() turns measurements into the JSON the website
consumes; validate() holds it to the same rules as the website's Zod schema (spec §2.3), so
a card that would fail the site build fails here first; render_md() writes every generation
verbatim with its label.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .hygiene import verdict_label
from .paths import REPO_ROOT

CARD_ID = "story-vs-tinystories"
TITLE = "The story model against TinyStories"
RUNNER = "llm-kit/compare/story_compare.py"

CAVEATS = [
    "The rubric quality of these stories has not been judged by a model or, until the human read is filled, by a person. Hygiene says what the guards would refuse, not whether the story is good.",
    "No perplexity: no text exists that neither model family saw.",
    "Different corpora: the TinyStories models trained on the V1 mixed GPT-3.5/GPT-4 data; Chittu on GPT-4 rows swept by its own guards. Sizes differ across the ladder.",
    "The Instruct model received a translated prompt it was never trained on.",
    "chittu-story-v0-26m has never served a child and clears none of the gates that would let it.",
]

_SLUG = re.compile(r"^[a-z0-9-]+$")
_KEY = re.compile(r"^[a-z0-9_]+$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CARD_LINK = re.compile(r"^/chittu/cards/[a-z0-9-]+\.md$")


def card_paths(date: str) -> tuple[Path, Path]:
    d = REPO_ROOT / "comparisons" / "cards"
    return d / f"{CARD_ID}-{date}.json", d / f"{CARD_ID}-{date}.md"


# --- validation (mirror of the website's Zod schema) -------------------------------------

def validate(c: dict) -> list[str]:  # noqa: C901 - one flat rule list is clearer than a class hierarchy
    p: list[str] = []
    need = lambda cond, msg: None if cond else p.append(msg)  # noqa: E731
    need(c.get("schema") == "chittu-comparison-card/1", "schema")
    need(isinstance(c.get("id"), str) and _SLUG.match(c["id"]), "id slug")
    need(c.get("kind") in ("behaviour", "story", "guard"), "kind")
    need(isinstance(c.get("date"), str) and _DATE.match(c["date"]), "date ISO")
    for k in ("title", "claim"):
        need(isinstance(c.get(k), str) and c[k].strip(), k)
    pb = c.get("producedBy") or {}
    need(pb.get("repo") == "Tulifo/chittu", "producedBy.repo")
    need(isinstance(pb.get("commit"), str) and _SHA.match(pb["commit"]), "producedBy.commit 40-hex")
    need(isinstance(pb.get("runner"), str) and pb["runner"], "producedBy.runner")
    systems = c.get("systems") or []
    need(len(systems) >= 2, "at least two systems")
    ids = [s.get("id") for s in systems]
    need(len(set(ids)) == len(ids), "system ids unique")
    need(sum(1 for s in systems if s.get("isChittu") is True) == 1, "exactly one isChittu")
    prompts = c.get("prompts") or []
    need(len(prompts) >= 1, "at least one prompt set")
    prompt_ids = {q.get("id") for q in prompts}
    for q in prompts:
        need(isinstance(q.get("count"), int) and q["count"] > 0, f"prompt {q.get('id')} count")
        need(isinstance(q.get("seeds"), list) and q["seeds"], f"prompt {q.get('id')} seeds")
        for k in ("label", "source"):
            need(isinstance(q.get(k), str) and q[k], f"prompt {q.get('id')} {k}")
    for s in systems:
        need(isinstance(s.get("probes"), list) and s["probes"], f"system {s.get('id')} probes")
        for pr in s.get("probes") or []:
            need(pr in prompt_ids, f"system {s.get('id')} names unknown probe {pr}")
        for k in ("label", "source", "revision"):
            need(isinstance(s.get(k), str) and s[k], f"system {s.get('id')} {k}")
    method = c.get("method") or {}
    for k in ("decoding", "grader"):
        need(isinstance(method.get(k), str) and method[k], f"method.{k}")
    need("judge" in method and (method["judge"] is None or isinstance(method["judge"], dict)), "method.judge")
    metrics = c.get("metrics") or []
    need(len(metrics) >= 1, "at least one metric")
    for m in metrics:
        need(isinstance(m.get("key"), str) and _KEY.match(m["key"]), "metric key")
        need(m.get("probe") in prompt_ids, f"metric {m.get('key')} names unknown probe {m.get('probe')}")
        need(isinstance(m.get("label"), str) and m["label"], f"metric {m.get('key')} label")
        need(m.get("unit") in ("percent", "count"), f"metric {m.get('key')} unit")
        need(isinstance(m.get("higherIsBetter"), bool), f"metric {m.get('key')} higherIsBetter")
        need(isinstance(m.get("denominator"), int) and m["denominator"] > 0, f"metric {m.get('key')} denominator")
        expected = sorted(s["id"] for s in systems if m.get("probe") in (s.get("probes") or []))
        values = m.get("values") if isinstance(m.get("values"), dict) else {}
        need(sorted(values) == expected, f"metric {m.get('key')} values must cover exactly {expected}")
        for sid, v in values.items():
            need(v is None or isinstance(v, (int, float)), f"metric {m.get('key')} value for {sid}")
            if v is None:
                need(isinstance((m.get("notes") or {}).get(sid), str), f"metric {m.get('key')}: null for {sid} needs a note")
    need(isinstance(c.get("controls"), list), "controls list")
    hr = c.get("humanRead") or {}
    keys = ("reviewer", "date", "sampleSize", "findings")
    all_null = all(hr.get(k) is None for k in keys)
    all_set = all(hr.get(k) not in (None, "") for k in keys)
    need(all_null or all_set, "humanRead all null or all set")
    if all_set:
        need(_DATE.match(str(hr["date"])) is not None and isinstance(hr["sampleSize"], int), "humanRead date/sampleSize")
    caveats = c.get("caveats")
    need(isinstance(caveats, list) and caveats and all(isinstance(x, str) and x.strip() for x in caveats), "caveats non-empty")
    links = c.get("links") or {}
    need(isinstance(links.get("card"), str) and _CARD_LINK.match(links["card"]), "links.card path")
    ext = links.get("external")
    need(isinstance(ext, list), "links.external list")
    for e in ext or []:
        need(isinstance(e.get("url"), str) and e["url"].startswith("https://"), "external url https")
        need(isinstance(e.get("label"), str) and e["label"], "external label")
    imp = c.get("imported", "missing")
    need(imp is None or (isinstance(imp, dict) and _SHA.match(str(imp.get("fromCommit", ""))) and _DATE.match(str(imp.get("at", "")))),
         "imported null or {fromCommit, at}")
    return p


# --- building -----------------------------------------------------------------------------

def _systems(meta: dict) -> list[dict]:
    items = sorted(meta["systems"].items(), key=lambda kv: (not kv[1]["is_chittu"], kv[0]))
    out = []
    for sid, m in items:
        s = {"id": sid, "label": m["label"], "isChittu": m["is_chittu"], "source": m["source"],
             "revision": m["revision"], "params": m["params"], "probes": list(m["probes"])}
        if m.get("notes"):
            s["notes"] = m["notes"]
        out.append(s)
    return out


def _metric(key, probe, label, folds, participants, denominator, field, pct_field):
    return {
        "key": key, "probe": probe, "label": label, "unit": "percent", "higherIsBetter": True,
        "denominator": denominator,
        "values": {sid: folds[sid][probe][pct_field] for sid in participants},
        "counts": {sid: folds[sid][probe][field] for sid in participants},
    }


def build_card(meta: dict, folds: dict, *, date: str, commit: str, human: dict | None = None,
               contamination: dict | None = None) -> dict:
    systems = _systems(meta)
    dec = meta["decoding"]
    seeds = list(dec["seeds"])
    metrics = []
    for probe, label_suffix in (("completion", "completions"), ("requests", "requests")):
        participants = [s["id"] for s in systems if probe in s["probes"]]
        if not participants:
            continue
        denominator = meta["prompts"][probe]["count"] * len(seeds)
        metrics.append(_metric(f"clean_{probe}", probe, f"Would pass Chittu's guards ({label_suffix})", folds, participants, denominator, "clean", "clean_pct"))
        metrics.append(_metric(f"ended_{probe}", probe, f"Reached an ending within the budget ({label_suffix})", folds, participants, denominator, "ended", "ended_pct"))
    chittu_id = next(s["id"] for s in systems if s["isChittu"])
    others = [v for k, v in metrics[0]["values"].items() if k != chittu_id]
    claim = (
        f"On the TinyStories paper's own prompts, {metrics[0]['values'][chittu_id]}% of the 26M Chittu story model's completions "
        f"would pass Chittu's child-safety guards, against {min(others)}–{max(others)}% for the TinyStories models measured beside it."
        if others else f"On the TinyStories paper's own prompts, {metrics[0]['values'][chittu_id]}% of the Chittu story model's completions would pass Chittu's child-safety guards."
    )
    controls = []
    if contamination is not None:
        if contamination["status"] == "run":
            controls.append({"label": "Contamination: no evaluation prompt or request appears verbatim in Chittu's training corpus",
                             "expected": "0 hits", "observed": f"{sum(len(v) for v in contamination['hits'].values())} hits over {contamination['records']} stories and {contamination['needles']} needles",
                             "passed": not contamination["hits"]})
        else:
            controls.append({"label": "Contamination check", "expected": "run", "observed": f"not run: {contamination['reason']}", "passed": False})
    human_read = ({"reviewer": human["reviewer"], "date": human["date"], "sampleSize": human["sample_size"], "findings": human["findings"]}
                  if human else {"reviewer": None, "date": None, "sampleSize": None, "findings": None})
    _, md_path = card_paths(date)
    return {
        "schema": "chittu-comparison-card/1",
        "id": CARD_ID, "kind": "story", "date": date, "title": TITLE, "claim": claim,
        "producedBy": {"repo": "Tulifo/chittu", "commit": commit, "runner": RUNNER},
        "systems": systems,
        "prompts": [
            {"id": "completion", "label": "the paper's 44 completion prompts", "source": meta["prompts"]["completion"]["source"],
             "count": meta["prompts"]["completion"]["count"], "seeds": seeds},
            {"id": "requests", "label": "20 requests written as a child types them", "source": meta["prompts"]["requests"]["source"],
             "count": meta["prompts"]["requests"]["count"], "seeds": seeds},
        ],
        "method": {
            "decoding": f"temperature {dec['temperature']}, top-k {dec['top_k']}; {dec['completion_tokens']} new tokens for completions, {dec['request_tokens']} for requests, in each model's own tokenizer; seeds {seeds}",
            "grader": "Chittu L1 scan() + L6 passesOutputFilter(), via pnpm story:sweep --fields text --verdicts",
            "judge": None,
        },
        "metrics": metrics,
        "controls": controls,
        "humanRead": human_read,
        "caveats": list(CAVEATS),
        "links": {
            "card": f"/chittu/cards/{md_path.name}",
            "external": [
                {"label": s["label"] + " on Hugging Face", "url": "https://huggingface.co/" + s["source"].split(":", 1)[1]} for s in systems
            ],
        },
        "imported": None,
    }


# --- the human card ----------------------------------------------------------------------

def render_md(card: dict, meta: dict, generations: dict, verdicts: dict, reports: dict,
              contamination: dict | None, human_text: str | None) -> str:
    L = [f"# {card['title']} — {card['date']}\n", f"{card['claim']}\n",
         "**The card is the artefact; the summary line is a convenience.** Every generation is below, verbatim, with the guards' verdict.\n",
         "## Systems\n", "| id | label | source | revision | parameters | probes |", "|---|---|---|---|---|---|"]
    for s in card["systems"]:
        L.append(f"| `{s['id']}` | {s['label']} | `{s['source']}` | `{s['revision']}` | {s['params']:,} | {', '.join(s['probes'])} |")
    L += ["\n## Method\n", f"- Decoding: {card['method']['decoding']}", f"- Grader: {card['method']['grader']}",
          f"- Judge: {'none' if card['method']['judge'] is None else card['method']['judge']}",
          f"- Versions: {meta.get('versions')}", ""]
    L += ["## Metrics\n", "| metric | probe | denominator | " + " | ".join(s["id"] for s in card["systems"]) + " |",
          "|---|---|---|" + "---|" * len(card["systems"])]
    for m in card["metrics"]:
        cells = [f"{m['values'][s['id']]}% ({m['counts'][s['id']]})" if s["id"] in m["values"] else "—" for s in card["systems"]]
        L.append(f"| {m['label']} | {m['probe']} | {m['denominator']} | " + " | ".join(cells) + " |")
    L.append("")
    if contamination is not None:
        L += ["## Contamination check\n", f"```json\n{json.dumps(contamination, indent=2, ensure_ascii=False)}\n```\n"]
    L += ["## What this does not show\n"] + [f"- {c}" for c in card["caveats"]] + [""]
    L += ["## Human read\n"]
    if human_text:
        hr = card["humanRead"]
        L += [f"- Reviewer: {hr['reviewer']}", f"- Date: {hr['date']}", f"- Sample size: {hr['sampleSize']}", "", human_text, ""]
    else:
        L += ["_Left blank for a person. Blind sample and rubric: `human-read/` beside the raw generations. A script must not fill this in._",
              "", "- Reviewer:", "- Date:", "- Sample size:", "- Findings:", ""]
    L += ["## Generations\n"]
    for s in card["systems"]:
        sid = s["id"]
        by_id = {v["id"]: v for v in verdicts.get(sid, [])}
        rep = reports.get(sid, {})
        L.append(f"### {s['label']} (`{sid}`) — sweep: {rep.get('kept')} kept of {rep.get('total')}, dropped {rep.get('dropped')}\n")
        for g in generations.get(sid, []):
            label = verdict_label(by_id[g["id"]])
            L.append(f"#### {g['probe']} {g['index']} · seed {g['seed']} · `[{label}]` · {g['chars']} chars · {'ended' if g['ended'] else 'cut at budget'}\n")
            L.append(f"**Prompt**\n\n```text\n{g['prompt']}\n```\n")
            if g.get("adapted"):
                L.append(f"**As the model saw it**\n\n```text\n{g['adapted']}\n```\n")
            L.append(f"**Output**\n\n```text\n{g['text']}\n```\n")
    return "\n".join(L)
