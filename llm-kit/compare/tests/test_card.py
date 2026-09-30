import copy
import json

import pytest

from compare import card
from compare.paths import REPO_ROOT

FIXTURE = json.loads((REPO_ROOT / "comparisons" / "fixtures" / "example-card.json").read_text())


def test_the_shared_fixture_validates():
    assert card.validate(FIXTURE) == []


def _broken(mutate):
    c = copy.deepcopy(FIXTURE)
    mutate(c)
    return c


@pytest.mark.parametrize("mutate", [
    lambda c: c["metrics"][0].pop("denominator"),
    lambda c: c.__setitem__("caveats", []),
    lambda c: c["systems"][1].__setitem__("isChittu", True),
    lambda c: c["metrics"][0]["values"].pop("tinystories-1m"),                       # participating system missing
    lambda c: c["metrics"][0]["values"].__setitem__("tinystories-instruct-33m", 1.0),  # non-participant present
    lambda c: c["metrics"][0]["values"].__setitem__("tinystories-1m", None),          # null without a note
    lambda c: c["humanRead"].__setitem__("reviewer", "Someone"),                      # half-filled
    lambda c: c.__setitem__("imported", {"fromCommit": "abc"}),
    lambda c: c["producedBy"].__setitem__("repo", "Tulifo/other"),
    lambda c: c["producedBy"].__setitem__("commit", "abc"),
    lambda c: c["links"].__setitem__("card", "/elsewhere/x.md"),
    lambda c: c["links"]["external"][0].__setitem__("url", "http://insecure"),
    lambda c: c["systems"][0]["probes"].append("nonsense"),
    lambda c: c["metrics"][0].__setitem__("probe", "nonsense"),
])
def test_broken_variants_are_refused(mutate):
    assert card.validate(_broken(mutate)) != []


def test_null_with_a_note_is_allowed():
    c = _broken(lambda c: (c["metrics"][0]["values"].__setitem__("tinystories-1m", None),
                           c["metrics"][0].__setitem__("notes", {"tinystories-1m": "did not run"})))
    assert card.validate(c) == []


def _meta():
    return {
        "date": "2026-10-02",
        "decoding": {"temperature": 0.6, "top_k": 50, "seeds": [42, 43, 44], "completion_tokens": 200, "request_tokens": 400},
        "prompts": {"completion": {"count": 44, "source": "TinyStories 'Evaluation prompts.yaml'"},
                    "requests": {"count": 20, "source": "llm-kit/nanochat/chittu/story_requests.txt"}},
        "systems": {
            "chittu-story-v0-26m": {"label": "Chittu story v0 (26M)", "is_chittu": True, "source": "huggingface:Tulifo/chittu-story-v0-26m",
                                    "revision": "4f11284f8ebc19348ce2885bfea66eb13c8717cc", "params": 26345726,
                                    "probes": ["completion", "requests"], "notes": "two checkpoints", "counts": {"completion": 132, "requests": 60}},
            "tinystories-33m": {"label": "TinyStories-33M", "is_chittu": False, "source": "huggingface:roneneldan/TinyStories-33M",
                                "revision": "2ad0a164221b7c4d21cac7c46aec74f6f98dbfc8", "params": 68000000,
                                "probes": ["completion"], "notes": None, "counts": {"completion": 132}},
            "tinystories-instruct-33m": {"label": "TinyStories-Instruct-33M", "is_chittu": False,
                                         "source": "huggingface:roneneldan/TinyStories-Instruct-33M",
                                         "revision": "a16a5748e848e534c3efa91b4d96dd752db27e5f", "params": 68000000,
                                         "probes": ["requests"], "notes": "adapter", "counts": {"requests": 60}},
        },
        "versions": {"python": "3.10.21", "torch": "2.9.1", "transformers": "4.57.0"},
    }


def _folds():
    return {
        "chittu-story-v0-26m": {"completion": {"total": 132, "clean": 132, "ended": 118, "by_kind": {}, "clean_pct": 100.0, "ended_pct": 89.4},
                                "requests": {"total": 60, "clean": 60, "ended": 60, "by_kind": {}, "clean_pct": 100.0, "ended_pct": 100.0}},
        "tinystories-33m": {"completion": {"total": 132, "clean": 129, "ended": 110, "by_kind": {"L6": 3}, "clean_pct": 97.7, "ended_pct": 83.3}},
        "tinystories-instruct-33m": {"requests": {"total": 60, "clean": 57, "ended": 59, "by_kind": {"L1:unsafe": 3}, "clean_pct": 95.0, "ended_pct": 98.3}},
    }


def test_build_card_is_valid_and_carries_the_numbers():
    c = card.build_card(_meta(), _folds(), date="2026-10-02", commit="a" * 40)
    assert card.validate(c) == []
    assert c["id"] == "story-vs-tinystories" and c["kind"] == "story" and c["imported"] is None
    assert c["links"]["card"] == "/chittu/cards/story-vs-tinystories-2026-10-02.md"
    m = {x["key"]: x for x in c["metrics"]}
    assert m["clean_completion"]["denominator"] == 132
    assert m["clean_completion"]["values"] == {"chittu-story-v0-26m": 100.0, "tinystories-33m": 97.7}
    assert m["clean_completion"]["counts"] == {"chittu-story-v0-26m": 132, "tinystories-33m": 129}
    assert m["ended_completion"]["values"]["tinystories-33m"] == 83.3
    assert m["clean_requests"]["values"] == {"chittu-story-v0-26m": 100.0, "tinystories-instruct-33m": 95.0}
    assert c["humanRead"] == {"reviewer": None, "date": None, "sampleSize": None, "findings": None}
    assert c["method"]["judge"] is None
    assert "100.0%" in c["claim"] and "97.7%" in c["claim"]
    assert c["caveats"] == card.CAVEATS
    assert [s["id"] for s in c["systems"]][0] == "chittu-story-v0-26m"


def test_build_card_folds_a_filled_human_read_and_contamination():
    human = {"reviewer": "Arun Kumar", "date": "2026-10-03", "sample_size": 40, "findings": "Chittu story v0 (26M) (requests) ends well."}
    contamination = {"status": "run", "records": 2327256, "needles": 64, "hits": {}}
    c = card.build_card(_meta(), _folds(), date="2026-10-02", commit="a" * 40, human=human, contamination=contamination)
    assert card.validate(c) == []
    assert c["humanRead"]["reviewer"] == "Arun Kumar" and c["humanRead"]["sampleSize"] == 40
    assert c["controls"][0]["label"].startswith("Contamination") and c["controls"][0]["passed"] is True


def test_render_md_prints_every_generation_with_its_label():
    c = card.build_card(_meta(), _folds(), date="2026-10-02", commit="a" * 40)
    gens = {"chittu-story-v0-26m": [{"id": "chittu-story-v0-26m:completion:0:42", "probe": "completion", "index": 0, "seed": 42,
                                     "prompt": "Once upon", "adapted": None, "text": "a time.", "chars": 7, "ended": True}]}
    verdicts = {"chittu-story-v0-26m": [{"id": "chittu-story-v0-26m:completion:0:42", "keep": True}]}
    reports = {"chittu-story-v0-26m": {"total": 1, "kept": 1, "dropped": {}, "samples": {}}}
    md = card.render_md(c, _meta(), gens, verdicts, reports, None, None)
    assert "# The story model against TinyStories" in md
    assert "`[clean]`" in md and "a time." in md
    assert "## Human read" in md and "Reviewer:" in md
    assert "The card is the artefact" in md
    assert "sweep: 1 kept of 1; dropped: none" in md
    assert "- Versions: python 3.10.21, torch 2.9.1, transformers 4.57.0" in md


def test_the_claim_names_one_figure_or_a_range():
    folds = _folds()
    claim = card.build_card(_meta(), folds, date="2026-10-02", commit="a" * 40)["claim"]
    assert claim.endswith("came to 97.7%.")
    assert claim.startswith("Trained only on stories Chittu's guards had already kept")   # the cause sits beside the figure
    assert card._span([93.9, 97.7, 95.0]) == "93.9–97.7%"


def test_card_paths():
    j, m = card.card_paths("2026-10-02")
    assert j == REPO_ROOT / "comparisons" / "cards" / "story-vs-tinystories-2026-10-02.json"
    assert m.name == "story-vs-tinystories-2026-10-02.md"


def test_the_caveats_say_what_a_refusal_is_and_whom_the_measure_favours():
    assert card.CAVEATS[0].startswith("A refusal is not a finding of harm.")
    assert "favours it by construction" in card.CAVEATS[1]
    assert len(card.CAVEATS) == 7
