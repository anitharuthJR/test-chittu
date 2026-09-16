from __future__ import annotations

import pytest

from chittu.common import write_jsonl
from tasks.chittu_stories import ChittuStories


def pair(i: int) -> dict:
    return {"messages": [{"role": "user", "content": f"Tell me a story {i}."}, {"role": "assistant", "content": f"Story {i}."}]}


def test_task_reads_pairs_and_supports_slicing(kit_env):
    _, data = kit_env
    write_jsonl(data / "stories.sft.train.jsonl", [pair(i) for i in range(4)])
    t = ChittuStories("train")
    assert len(t) == 4 and t.num_examples() == 4
    assert t[1] == pair(1)
    assert len(ChittuStories("train", start=1, stop=3)) == 2


def test_task_refuses_a_malformed_pair(kit_env):
    _, data = kit_env
    write_jsonl(data / "stories.sft.val.jsonl", [{"messages": [{"role": "assistant", "content": "x"}, {"role": "user", "content": "y"}]}])
    t = ChittuStories("val")
    with pytest.raises(AssertionError):
        t[0]


def test_task_rejects_an_unknown_split(kit_env):
    with pytest.raises(AssertionError):
        ChittuStories("test")
