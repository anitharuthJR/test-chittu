from __future__ import annotations

import json
from pathlib import Path

from chittu import story_eval as se
from chittu.common import write_jsonl

YAML = (
    "---\n"
    "- |-\n  Once upon a time, there lived a bunny.\n  She was so weak she could\n"
    "- |-\n  One day a girl walked in.\n\n  She saw\n"
    "- |-\n  Jack asked his mom.\n"
)


def test_load_eval_prompts_parses_block_scalars_keeping_inner_blank_lines(tmp_path):
    p = tmp_path / "e.yaml"
    p.write_text(YAML, encoding="utf-8")
    assert se.load_eval_prompts(p) == [
        "Once upon a time, there lived a bunny.\nShe was so weak she could",
        "One day a girl walked in.\n\nShe saw",
        "Jack asked his mom.",
    ]


class FakeTok:
    def get_bos_token_id(self):
        return 1

    def encode_special(self, s):
        return {"<|user_start|>": 2, "<|user_end|>": 3, "<|assistant_start|>": 4, "<|assistant_end|>": 5}[s]

    def encode(self, text):
        return [100 + i for i in range(len(text.split()))]

    def decode(self, ids):
        return " ".join(f"t{i}" for i in ids)


class FakeEngine:
    def generate(self, tokens, num_samples, max_tokens, temperature, top_k, seed):
        assert (num_samples, temperature, top_k, seed) == (1, 0.6, 50, 42)
        for t in [9, 8, 5]:
            yield [t], [True]


def test_request_tokens_open_a_turn_exactly_like_chat_cli():
    assert se.request_tokens(FakeTok(), "tell me a story") == [1, 2, 100, 101, 102, 103, 3, 4]
    assert se.completion_tokens(FakeTok(), "Once upon") == [1, 100, 101]


def test_strip_stops_drops_only_stop_ids():
    assert se.strip_stops([7, 5, 8, 1], {1, 5}) == [7, 8]


def test_generate_text_collects_then_strips_the_stop():
    assert se.generate_text(FakeEngine(), FakeTok(), [1, 2], max_tokens=10, stop_ids={5}) == "t9 t8"


def test_requests_are_twenty_child_written_lines_not_templates():
    reqs = se.load_requests()
    assert len(reqs) == 20 and all(0 < len(r) < 80 for r in reqs)
    assert not any("Tell me a story using the words" in r or "Tell me a story about this:" in r for r in reqs)


def test_hygiene_rates():
    h = se.hygiene({"total": 10, "kept": 7, "dropped": {"L1:crisis": 2, "L1:pii": 0, "L6": 1}})
    assert (h["l1_hits"], h["l6_fails"], h["l1_clean_pct"], h["l6_clean_pct"]) == (2, 1, "80.00", "87.50")
    assert se.hygiene(None) == {"available": False}


def test_render_card_has_every_section_and_a_blank_human_read():
    meta = {
        "model_tag": "story-d6-smoke", "date": "2026-09-16", "sampling": se.SAMPLING, "completion_tokens": 200,
        "device_type": "mps", "dtype": "torch.float32",
        "base": {"step": 50, "val_bpb": 2.5, "model_config": {"n_layer": 6, "vocab_size": 8192, "sequence_len": 512}},
        "sft": {"step": 20, "val_bpb": None}, "probes": {"completion": 1, "request": 1},
    }
    gens = [
        {"probe": "completion", "index": 0, "prompt": "Once upon a time", "text": "there was a hat."},
        {"probe": "request", "index": 0, "prompt": "tell me a story about rain", "text": "Rain fell. The end."},
    ]
    sweep = {"total": 2, "kept": 1, "dropped": {"L1:crisis": 1, "L1:pii": 0, "L6": 0}}
    md = se.render_card(meta, gens, sweep, {"dataset_sha256": "abc", "nanochat_upstream": "92d63d4", "counts": {"train": 1}}, {"base_train": 12})
    for needle in (
        "# Story model scorecard — story-d6-smoke — 2026-09-16",
        "| depth / vocab / seq len | 6 / 8192 / 512 |",
        "`abc`",
        "#### completion 1",
        "#### request 1",
        "Rain fell. The end.",
        "| 2 | 1 | 0 | 50.00 | 100.00 |",
        "L1:crisis 1",
        "## Human read",
        "- Reviewer:",
        "| SFT steps · val_bpb | 20 · n/a |",
    ):
        assert needle in md, needle
    assert "n/a" in se.render_card(meta, gens, None, {}, {})  # missing inputs print as n/a, never as zero


def test_render_card_prints_na_for_absent_checkpoint_fields_never_none():
    meta = {
        "model_tag": "t", "date": "2026-09-16", "sampling": se.SAMPLING, "completion_tokens": 200,
        "base": {"step": None, "val_bpb": None, "model_config": {}}, "sft": {"step": None, "val_bpb": None},
        "probes": {"completion": 0, "request": 0},
    }
    md = se.render_card(meta, [], {"total": 1, "kept": 1, "dropped": {"L6": 0}}, {}, {})
    assert "| pretrain steps · val_bpb | n/a · n/a |" in md
    assert "| SFT steps · val_bpb | n/a · n/a |" in md
    assert "val_bpb (base) = n/a ·" in md
    assert "None" not in md
    assert '"n/a"' not in md


def test_card_round_trips_from_written_files(kit_env, tmp_path):
    """card() reads exactly what generate() writes, plus a sweep report — end to end,
    no mocked internals."""
    _base, _data = kit_env
    out_dir = tmp_path / "eval-out"
    out_dir.mkdir()
    meta = {
        "model_tag": "story-d6-smoke", "date": "2026-09-16", "sampling": se.SAMPLING, "completion_tokens": 200,
        "device_type": "mps", "dtype": "torch.float32",
        "base": {"step": 50, "val_bpb": 2.5, "model_config": {"n_layer": 6, "vocab_size": 8192, "sequence_len": 512}},
        "sft": {"step": 20, "val_bpb": 1.1}, "probes": {"completion": 1, "request": 1},
    }
    (out_dir / "eval-meta.json").write_text(json.dumps(meta), encoding="utf-8")
    write_jsonl(
        out_dir / "generations.jsonl",
        [
            {"probe": "completion", "index": 0, "prompt": "Once upon a time", "text": "there was a hat."},
            {"probe": "request", "index": 0, "prompt": "tell me a story about rain", "text": "Rain fell. The end."},
        ],
    )
    (out_dir / "generations-sweep.json").write_text(json.dumps({"total": 2, "kept": 2, "dropped": {"L1:crisis": 0, "L6": 0}}), encoding="utf-8")
    card_path = tmp_path / "card.md"
    se.card(out_dir, card_path, manifest_path=Path("missing"), timings_path=Path("missing"))
    text = card_path.read_text(encoding="utf-8")
    assert "#### completion 1" in text
    assert "#### request 1" in text
    assert "| 2 | 0 | 0 | 100.00 | 100.00 |" in text  # the hygiene table row
    assert "## Human read" in text
