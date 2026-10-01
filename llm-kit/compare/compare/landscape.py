"""The landscape card is authored by hand; this holds it to the website's rules before it is committed."""
from __future__ import annotations

import re

_SLUG = re.compile(r"^[a-z0-9-]+$")
_KEY = re.compile(r"^[a-z0-9_]+$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CARD_LINK = re.compile(r"^/chittu/cards/[a-z0-9-]+\.md$")


def validate_landscape(c: dict) -> list[str]:  # noqa: C901
    p: list[str] = []
    need = lambda cond, msg: None if cond else p.append(msg)  # noqa: E731
    need(c.get("schema") == "chittu-comparison-card/1", "schema")
    need(c.get("kind") == "landscape", "kind landscape")
    need(isinstance(c.get("id"), str) and _SLUG.match(c["id"]), "id slug")
    need(isinstance(c.get("date"), str) and _DATE.match(c["date"]), "date ISO")
    for k in ("title", "claim"):
        need(isinstance(c.get(k), str) and c[k].strip(), k)
    pb = c.get("producedBy") or {}
    need(pb.get("repo") == "Tulifo/chittu" and isinstance(pb.get("commit"), str) and _SHA.match(pb["commit"]) and pb.get("runner"), "producedBy")
    systems = c.get("systems") or []
    ids = [s.get("id") for s in systems]
    need(len(systems) >= 2 and len(set(ids)) == len(ids), "systems ≥2, unique")
    need(sum(1 for s in systems if s.get("isChittu") is True) == 1, "exactly one isChittu")
    for s in systems:
        for k in ("label", "source", "revision"):
            need(isinstance(s.get(k), str) and s[k], f"system {s.get('id')} {k}")
        need(isinstance(s.get("probes"), list) and s["probes"], f"system {s.get('id')} probes")
    columns = c.get("columns") or []
    need(len(columns) >= 1, "columns non-empty")
    keys = sorted(col.get("key") for col in columns)
    for col in columns:
        need(isinstance(col.get("key"), str) and _KEY.match(col["key"]) and isinstance(col.get("label"), str) and col["label"], "column key/label")
    rows = c.get("rows") or []
    need(len(rows) >= 2, "rows ≥2")
    for r in rows:
        need(r.get("system") in ids, f"row {r.get('system')} is not a system")
        cells = r.get("cells") if isinstance(r.get("cells"), dict) else {}
        need(sorted(cells) == keys, f"row {r.get('system')} must have every column and no others")
        for k, cell in cells.items():
            need(isinstance(cell, dict) and isinstance(cell.get("value"), str) and cell["value"].strip(), f"row {r.get('system')} {k} value")
            need(isinstance(cell.get("source"), str) and cell["source"].startswith("https://"), f"row {r.get('system')} {k} source https")
            need(isinstance(cell.get("asOf"), str) and _DATE.match(cell["asOf"]), f"row {r.get('system')} {k} asOf")
    caveats = c.get("caveats")
    need(isinstance(caveats, list) and caveats and all(isinstance(x, str) and x.strip() for x in caveats), "caveats non-empty")
    links = c.get("links") or {}
    need(isinstance(links.get("card"), str) and _CARD_LINK.match(links["card"]), "links.card")
    need(isinstance(links.get("external"), list) and all(isinstance(e.get("url"), str) and e["url"].startswith("https://") for e in links["external"]), "links.external")
    need(c.get("imported", "missing") is None, "imported null")
    return p
