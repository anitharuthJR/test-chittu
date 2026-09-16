"""Fixtures for the story kit tests. Tarballs are built in-test; nothing touches the network."""
from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest


def rec(
    story: str,
    *,
    source: str = "GPT-4",
    features: tuple[str, ...] = (),
    words: tuple[str, ...] = ("sun", "hat", "run"),
    summary: str = "A short summary.",
) -> dict:
    """A TinyStories record in the tarball's exact shape (note upstream's 'prompt:' key)."""
    return {
        "story": story,
        "instruction": {"prompt:": "Write a short story", "words": list(words), "features": list(features)},
        "summary": summary,
        "source": source,
    }


def make_tar(path: Path, members: dict[str, list[dict]]) -> Path:
    """Write {member name -> list of records} as a .tar.gz of JSON arrays, in dict order."""
    with tarfile.open(path, "w:gz") as tar:
        for name, records in members.items():
            payload = json.dumps(records).encode("utf-8")
            info = tarfile.TarInfo(name=name)
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    return path


@pytest.fixture
def kit_env(tmp_path, monkeypatch):
    """Point the kit at a scratch base dir; returns (base, data_dir)."""
    base = tmp_path / "base"
    data = base / "stories_data"
    monkeypatch.setenv("NANOCHAT_BASE_DIR", str(base))
    monkeypatch.setenv("NANOCHAT_DATA_DIR", str(data))
    data.mkdir(parents=True)
    return base, data
