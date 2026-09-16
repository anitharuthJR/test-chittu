from __future__ import annotations

import json

import pytest

from chittu import prepare_stories as ps
from chittu.conftest import make_tar, rec


def test_schema_missing_field_aborts_naming_the_record(tmp_path):
    bad = {"story": "x", "instruction": {"words": [], "features": []}, "source": "GPT-4"}  # no summary
    tar = make_tar(tmp_path / "t.tar.gz", {"data00.json": [bad]})
    with pytest.raises(SystemExit, match=r"data00\.json\[0\] lacks 'summary'"):
        ps.prepare(tar, tmp_path / "o.jsonl", tmp_path / "r.json", keep_sources={"GPT-4"}, drop_features={"BadEnding"})


def test_schema_non_string_list_entry_aborts_naming_the_element(tmp_path):
    bad = rec("A story.")
    bad["instruction"]["words"] = ["sun", 3]
    tar = make_tar(tmp_path / "t.tar.gz", {"data00.json": [bad]})
    with pytest.raises(SystemExit, match=r"data00\.json\[0\] has a non-string 'instruction\.words\[1\]'"):
        ps.prepare(tar, tmp_path / "o.jsonl", tmp_path / "r.json", keep_sources=None, drop_features=set())


def test_schema_abort_on_second_record_leaves_no_partial_output(tmp_path):
    """The partial-output hazard: record 1 writes fine, record 2 aborts. Neither the
    final jsonl nor its .tmp may survive — a partial file must never look complete."""
    good = rec("A perfectly fine story.")
    bad = {"story": "x", "instruction": {"words": [], "features": []}, "source": "GPT-4"}  # no summary
    tar = make_tar(tmp_path / "t.tar.gz", {"data00.json": [good, bad]})
    out = tmp_path / "o.jsonl"
    with pytest.raises(SystemExit, match=r"data00\.json\[1\] lacks 'summary'"):
        ps.prepare(tar, out, tmp_path / "r.json", keep_sources=None, drop_features=set())
    assert not out.exists()
    assert not out.with_name(out.name + ".tmp").exists()


def test_happy_path_leaves_no_tmp_file(tmp_path):
    tar = make_tar(tmp_path / "t.tar.gz", {"d.json": [rec("A perfectly fine story.")]})
    out = tmp_path / "o.jsonl"
    ps.prepare(tar, out, tmp_path / "r.json", keep_sources=None, drop_features=set())
    assert out.exists()
    assert not out.with_name(out.name + ".tmp").exists()


def test_filters_source_feature_and_duplicates_in_archive_order(tmp_path):
    good = "Once upon a time, a sparrow found a mango."
    tar = make_tar(
        tmp_path / "t.tar.gz",
        {
            "data01.json": [
                rec(good),
                rec("A cat sat.", source="GPT-3.5"),
                rec("Sad end.", features=("Dialogue", "BadEnding")),
                rec("  " + good + "\n"),  # a duplicate after strip
            ],
            "data00.json": [rec("Second good story.")],
        },
    )
    out = tmp_path / "o.jsonl"
    report = ps.prepare(tar, out, tmp_path / "r.json", keep_sources={"GPT-4"}, drop_features={"BadEnding"})
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert [r["story"] for r in rows] == [good, "Second good story."]  # archive order, not name order
    assert (report["total"], report["kept"]) == (5, 2)
    assert (report["dropped_source"], report["dropped_feature"], report["dropped_duplicate"]) == (1, 1, 1)
    assert report["by_source"] == {"GPT-4": 4, "GPT-3.5": 1}
    assert rows[0] == {"id": ps.record_id(good), "story": good, "words": ["sun", "hat", "run"], "features": [], "summary": "A short summary.", "source": "GPT-4"}
    assert json.loads((tmp_path / "r.json").read_text(encoding="utf-8"))["kept"] == 2


def test_id_is_stable_under_whitespace_and_16_hex():
    assert ps.record_id("  Once upon\n") == ps.record_id("Once upon")
    assert len(ps.record_id("x")) == 16 and int(ps.record_id("x"), 16) >= 0


def test_limit_stops_after_n_kept(tmp_path):
    tar = make_tar(tmp_path / "t.tar.gz", {"d.json": [rec(f"Story {i}.") for i in range(5)]})
    out = tmp_path / "o.jsonl"
    report = ps.prepare(tar, out, tmp_path / "r.json", keep_sources=None, drop_features=set(), limit=2)
    assert report["kept"] == 2 and len(out.read_text().splitlines()) == 2 and report["limit"] == 2


def test_source_any_keeps_gpt35(tmp_path):
    tar = make_tar(tmp_path / "t.tar.gz", {"d.json": [rec("A.", source="GPT-3.5"), rec("B.")]})
    report = ps.prepare(tar, tmp_path / "o.jsonl", tmp_path / "r.json", keep_sources=None, drop_features=set())
    assert report["kept"] == 2 and report["keep_sources"] == "any"


def test_main_skips_when_output_exists(kit_env, monkeypatch, capsys):
    _, data = kit_env
    (data / "stories.raw.jsonl").write_text('{"id":"keep"}\n')

    def refuse(name):
        raise AssertionError("must not download when skipping")

    monkeypatch.setattr(ps, "ensure_source", refuse)
    assert ps.main([]) == 0
    assert (data / "stories.raw.jsonl").read_text() == '{"id":"keep"}\n'
    assert "skipping" in capsys.readouterr().out


def test_main_end_to_end_with_defaults(kit_env, monkeypatch, tmp_path):
    _, data = kit_env
    tar = make_tar(tmp_path / "t.tar.gz", {"d.json": [rec("Good."), rec("Bad end.", features=("BadEnding",)), rec("Old.", source="GPT-3.5")]})
    monkeypatch.setattr(ps, "ensure_source", lambda name: tar if name == ps.TAR_NAME else tmp_path / "prompts.yaml")
    assert ps.main([]) == 0
    assert len((data / "stories.raw.jsonl").read_text().splitlines()) == 1
    report = json.loads((data / "prepare-report.json").read_text(encoding="utf-8"))
    assert (report["dropped_feature"], report["dropped_source"], report["drop_features"], report["keep_sources"]) == (1, 1, ["BadEnding"], ["GPT-4"])
