from __future__ import annotations

import pytest

from chittu import check_sft_fits as csf
from chittu.common import write_jsonl


class FakeTok:
    """Renders one token per character of every message, plus four specials — enough to test the arithmetic."""

    def render_conversation(self, conversation):
        n = sum(len(m["content"]) for m in conversation["messages"]) + 4
        return list(range(n)), [1] * n


def test_first_overflow_names_the_first_pair_over_capacity():
    assert csf.first_overflow([10, 513, 514, 900], 513) == 2
    assert csf.first_overflow([1, 2, 3], 513) is None


def test_render_lengths_uses_the_tokenizer_on_every_pair(tmp_path):
    p = tmp_path / "s.jsonl"
    write_jsonl(p, [{"messages": [{"role": "user", "content": "ab"}, {"role": "assistant", "content": "cde"}]}, {"messages": [{"role": "user", "content": "x" * 600}, {"role": "assistant", "content": ""}]}])
    assert csf.render_lengths(FakeTok(), p) == [9, 604]


def test_check_reports_and_fails_on_an_overflow(tmp_path, kit_env, capsys):
    _, data = kit_env
    write_jsonl(data / "stories.sft.train.jsonl", [{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b" * 600}]}])
    write_jsonl(data / "stories.sft.val.jsonl", [{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}])
    with pytest.raises(SystemExit, match=r"train\[0\] renders to 605 tokens"):
        csf.check(FakeTok(), max_seq_len=512)


def test_check_passes_and_prints_the_maximum(tmp_path, kit_env, capsys):
    _, data = kit_env
    write_jsonl(data / "stories.sft.train.jsonl", [{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b" * 100}]}])
    write_jsonl(data / "stories.sft.val.jsonl", [{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}])
    assert csf.check(FakeTok(), max_seq_len=512) == 105
    assert "max 105" in capsys.readouterr().out
