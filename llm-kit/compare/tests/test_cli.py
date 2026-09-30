import json

import pytest

import story_compare
from compare import generate
from compare.io_utils import write_jsonl


def test_help_for_every_subcommand(capsys):
    for sub in ("generate", "sweep", "blind", "card"):
        with pytest.raises(SystemExit) as e:
            story_compare.main([sub, "--help"])
        assert e.value.code == 0
        assert "--out" in capsys.readouterr().out


def test_card_command_refuses_when_the_instrument_disagrees(tmp_path, fake_systems, monkeypatch):
    generate.run_generate(fake_systems, ["Once upon", "Lily found"], ["tell me a story about rain"], tmp_path, seeds=(42,))
    # Fake sweep artefacts for every system, but one report claims a different total.
    for sid in ("chittu-story-v0-26m", "tinystories-33m", "tinystories-instruct-33m"):
        d = tmp_path / sid
        gens = [json.loads(l) for l in (d / "generations.jsonl").read_text().splitlines()]
        write_jsonl(d / "verdicts.jsonl", [{"id": g["id"], "keep": True} for g in gens])
        total = len(gens) if sid != "tinystories-33m" else len(gens) + 1
        (d / "sweep.json").write_text(json.dumps({"total": total, "kept": total, "dropped": {}, "samples": {}}))
    with pytest.raises(SystemExit) as e:
        story_compare.main(["card", "--out", str(tmp_path), "--skip-contamination", "--commit", "b" * 40])
    assert "instrument check failed" in str(e.value)


def test_card_command_writes_both_files(tmp_path, fake_systems, monkeypatch):
    generate.run_generate(fake_systems, ["Once upon", "Lily found"], ["tell me a story about rain"], tmp_path, seeds=(42,))
    for sid in ("chittu-story-v0-26m", "tinystories-33m", "tinystories-instruct-33m"):
        d = tmp_path / sid
        gens = [json.loads(l) for l in (d / "generations.jsonl").read_text().splitlines()]
        write_jsonl(d / "verdicts.jsonl", [{"id": g["id"], "keep": True} for g in gens])
        (d / "sweep.json").write_text(json.dumps({"total": len(gens), "kept": len(gens), "dropped": {}, "samples": {}}))
    cards_dir = tmp_path / "cards"
    monkeypatch.setattr(story_compare.card, "card_paths", lambda date: (cards_dir / f"story-vs-tinystories-{date}.json", cards_dir / f"story-vs-tinystories-{date}.md"))
    assert story_compare.main(["card", "--out", str(tmp_path), "--skip-contamination", "--commit", "b" * 40, "--date", "2026-10-02"]) == 0
    c = json.loads((cards_dir / "story-vs-tinystories-2026-10-02.json").read_text())
    assert c["metrics"][0]["denominator"] == 2 and c["humanRead"]["reviewer"] is None
    assert (cards_dir / "story-vs-tinystories-2026-10-02.md").read_text().count("#### ") == 2 + 2 + 1 + 1
