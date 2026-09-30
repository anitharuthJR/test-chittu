import json
import re

import pytest

from compare import blind, generate

PROMPTS = [f"prompt {i}" for i in range(12)]
REQUESTS = [f"tell me a story about thing {i}" for i in range(12)]


def test_make_blind_letters_are_unique_across_probes_and_key_unblinds(tmp_path, fake_systems):
    generate.run_generate(fake_systems, PROMPTS, REQUESTS, tmp_path, seeds=(42,))
    human = blind.make_blind(tmp_path, seed=7, per_system=10)
    key = json.loads((human / "key.json").read_text())
    # chittu + 33m take completions (2 letters), chittu + instruct take requests (2 letters)
    assert sorted(key) == ["A", "B", "C", "D"]
    assert sorted((v["system"], v["probe"]) for v in key.values()) == sorted([
        ("chittu-story-v0-26m", "completion"), ("tinystories-33m", "completion"),
        ("chittu-story-v0-26m", "requests"), ("tinystories-instruct-33m", "requests"),
    ])
    for letter in key:
        md = (human / f"{letter}.md").read_text()
        assert md.count("### Item ") == 10
        # Blind: nothing the renderer adds names a system. (The fake systems echo their own id
        # into the text they "generate", so the fenced prompt and output blocks are set aside.)
        scaffold = re.sub(r"```text\n.*?\n```", "", md, flags=re.S).lower()
        assert "chittu" not in scaffold and "tinystories" not in scaffold
    assert (human / "FINDINGS.md").read_text().startswith("reviewer: \n")


def test_read_findings_blank_is_none_and_half_filled_raises(tmp_path):
    p = tmp_path / "FINDINGS.md"
    p.write_text(blind.FINDINGS_TEMPLATE)
    assert blind.read_findings(p) is None
    p.write_text("reviewer: Arun Kumar\ndate: \nsample_size: 40\n\nSystem A rambles.\n")
    with pytest.raises(ValueError):
        blind.read_findings(p)
    p.write_text("reviewer: Arun Kumar\ndate: 2026-10-03\nsample_size: 40\n\nSystem A rambles.\nSystem B ends well.\n")
    assert blind.read_findings(p) == {"reviewer": "Arun Kumar", "date": "2026-10-03", "sample_size": 40,
                                      "findings": "System A rambles.\nSystem B ends well."}


def test_unblind_replaces_letters_with_labels():
    key = {"A": {"system": "tinystories-33m", "probe": "completion"}, "B": {"system": "chittu-story-v0-26m", "probe": "requests"}}
    labels = {"tinystories-33m": "TinyStories-33M", "chittu-story-v0-26m": "Chittu story v0 (26M)"}
    out = blind.unblind("System A rambles. System B ends well. Systematic is not a letter.", key, labels)
    assert out == "TinyStories-33M (completion) rambles. Chittu story v0 (26M) (requests) ends well. Systematic is not a letter."
