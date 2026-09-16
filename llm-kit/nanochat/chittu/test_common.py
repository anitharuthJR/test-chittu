from __future__ import annotations

import pytest

from chittu import common


def test_sha256_file_and_text_agree(tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("hello\n")
    assert common.sha256_file(p) == common.sha256_text("hello\n")
    assert common.sha256_text("hello\n") == "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"


def test_data_dir_env_and_default(monkeypatch, tmp_path):
    monkeypatch.setenv("NANOCHAT_BASE_DIR", str(tmp_path))
    monkeypatch.delenv("NANOCHAT_DATA_DIR", raising=False)
    assert common.data_dir() == tmp_path / "stories_data"
    assert common.sources_dir() == tmp_path / "sources"
    monkeypatch.setenv("NANOCHAT_DATA_DIR", str(tmp_path / "elsewhere"))
    assert common.data_dir() == tmp_path / "elsewhere"


def test_sources_json_pins_the_two_files_and_upstream():
    s = common.load_sources()
    assert set(s["sources"]) == {"TinyStories_all_data.tar.gz", "Evaluation prompts.yaml"}
    for spec in s["sources"].values():
        assert len(spec["sha256"]) == 64 and spec["url"].startswith("https://huggingface.co/datasets/roneneldan/TinyStories/")
        assert spec["licence"] == "CDLA-Sharing-1.0"
    assert s["nanochat_upstream"] == "92d63d4e8bb4df75c3b71618f31ddde2378b2bcd"


def test_ensure_source_downloads_then_verifies(tmp_path, monkeypatch):
    origin = tmp_path / "origin.txt"
    origin.write_text("pinned\n")
    monkeypatch.setenv("NANOCHAT_BASE_DIR", str(tmp_path / "base"))
    monkeypatch.setattr(common, "load_sources", lambda: {"sources": {"origin.txt": {"url": origin.as_uri(), "sha256": common.sha256_text("pinned\n")}}})
    got = common.ensure_source("origin.txt")
    assert got == tmp_path / "base" / "sources" / "origin.txt" and got.read_text() == "pinned\n"
    assert common.ensure_source("origin.txt") == got  # second call: present, verified, not re-downloaded


def test_ensure_source_refuses_a_wrong_hash(tmp_path, monkeypatch):
    origin = tmp_path / "origin.txt"
    origin.write_text("pinned\n")
    monkeypatch.setenv("NANOCHAT_BASE_DIR", str(tmp_path / "base"))
    monkeypatch.setattr(common, "load_sources", lambda: {"sources": {"origin.txt": {"url": origin.as_uri(), "sha256": "0" * 64}}})
    with pytest.raises(SystemExit, match="sha256 mismatch"):
        common.ensure_source("origin.txt")


def test_jsonl_roundtrip_keeps_unicode(tmp_path):
    p = tmp_path / "r.jsonl"
    assert common.write_jsonl(p, [{"a": 1}, {"b": "சிட்டு"}]) == 2
    assert list(common.read_jsonl(p)) == [{"a": 1}, {"b": "சிட்டு"}]
    assert "சிட்டு" in p.read_text(encoding="utf-8")
