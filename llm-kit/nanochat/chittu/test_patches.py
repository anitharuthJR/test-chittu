"""
Pins on the two upstream files this kit patches. A `git subtree pull` that reverts either
patch fails HERE, in milliseconds, instead of at the end of a two-hour run.
"""
from __future__ import annotations

import hashlib
import importlib
from pathlib import Path

NANOCHAT_ROOT = Path(__file__).resolve().parents[1]


def test_dataset_honours_nanochat_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NANOCHAT_DATA_DIR", str(tmp_path / "stories_data"))
    import nanochat.dataset as ds

    importlib.reload(ds)
    assert ds.DATA_DIR == str(tmp_path / "stories_data")


def test_dataset_default_is_upstreams_when_unset(monkeypatch):
    monkeypatch.delenv("NANOCHAT_DATA_DIR", raising=False)
    import nanochat.dataset as ds

    importlib.reload(ds)
    assert ds.DATA_DIR.endswith("base_data_climbmix")


def test_chat_sft_has_the_story_mixture_switch_guarding_the_downloads():
    src = (NANOCHAT_ROOT / "scripts" / "chat_sft.py").read_text(encoding="utf-8")
    assert '"--mixture"' in src and 'choices=["default", "chittu_stories"]' in src
    assert "from tasks.chittu_stories import ChittuStories" in src
    assert 'SmolTalk(split="train")' in src  # the default path is still upstream's
    # The story branch comes BEFORE the default task construction, so choosing it never
    # instantiates SmolTalk/MMLU/GSM8K (each of which downloads from the Hub).
    assert src.index('if args.mixture == "chittu_stories":') < src.index('SmolTalk(split="train")')


def test_chat_sft_default_tasks_are_built_only_inside_the_else_branch():
    """
    A STRUCTURAL pin, because a text pin cannot see indentation: every SmolTalk/MMLU/GSM8K
    construction must sit inside the `orelse` of the --mixture switch, so choosing
    chittu_stories can never instantiate a task that downloads from the Hub. Dropping the
    `else:` and un-indenting the default block passes the text pin above and fails here.
    """
    import ast

    src = (NANOCHAT_ROOT / "scripts" / "chat_sft.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    switches = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.If) and ast.get_source_segment(src, node.test) == 'args.mixture == "chittu_stories"'
    ]
    assert len(switches) == 1, "exactly one --mixture switch"
    switch = switches[0]
    assert switch.orelse, "the mixture switch has no else branch — the default tasks would run unconditionally"
    in_else = {id(n) for stmt in switch.orelse for n in ast.walk(stmt)}
    builders = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in {"SmolTalk", "MMLU", "GSM8K"}
    ]
    assert builders, "positive control: the default branch still builds SmolTalk/MMLU/GSM8K"
    outside = [n.func.id for n in builders if id(n) not in in_else]
    assert not outside, f"default-task constructions outside the else branch: {outside}"


def test_read_arxiv_paper_skill_file_is_pinned():
    """
    An agent-instruction file that arrives from a `git subtree pull` must not change
    unread: a pull that changes it fails here so a human reads it before it loads.
    """
    skill = NANOCHAT_ROOT / ".claude" / "skills" / "read-arxiv-paper" / "SKILL.md"
    digest = hashlib.sha256(skill.read_bytes()).hexdigest()
    assert digest == "5b7a49e740abe8aaead528e3acc3bd0b9404465761702acc3da95dd87d2b2811"
