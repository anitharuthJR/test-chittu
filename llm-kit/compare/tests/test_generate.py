import json

from compare import generate
from compare.io_utils import read_jsonl

PROMPTS = ["Once upon a time, there was a", "Lily found a red"]
REQUESTS = ["tell me a story about rain", "a story about a tiny elephant", "make a story about the moon"]


def test_generation_id_is_stable_and_unique_per_cell():
    assert generate.generation_id("x", "completion", 3, 42) == "x:completion:3:42"


def test_adapted_prompt_only_for_gptneo_requests(fake_systems):
    chittu, neo, instruct = (s.spec for s in fake_systems)
    assert generate.adapted_prompt(chittu, "requests", "tell me a story about rain") is None
    assert generate.adapted_prompt(neo, "completion", "Once") is None
    assert generate.adapted_prompt(instruct, "requests", "tell me a story about rain") == "Summary: A story about rain.\nStory: \n"


def test_run_generate_writes_every_cell_once(tmp_path, fake_systems):
    meta = generate.run_generate(fake_systems, PROMPTS, REQUESTS, tmp_path, seeds=(42, 43))
    chittu = read_jsonl(tmp_path / "chittu-story-v0-26m" / "generations.jsonl")
    assert len(chittu) == 2 * 2 + 3 * 2                    # completions + requests, two seeds
    assert len(read_jsonl(tmp_path / "tinystories-33m" / "generations.jsonl")) == 2 * 2
    ins = read_jsonl(tmp_path / "tinystories-instruct-33m" / "generations.jsonl")
    assert len(ins) == 3 * 2
    ids = [r["id"] for r in chittu]
    assert len(set(ids)) == len(ids)
    row = chittu[0]
    assert set(row) == {"id", "system", "probe", "index", "seed", "prompt", "adapted", "text", "chars", "ended"}
    assert row["probe"] == "completion" and row["adapted"] is None and row["chars"] == len(row["text"])
    assert {r["ended"] for r in chittu} == {True, False}
    assert all(r["adapted"].startswith("Summary: ") for r in ins)
    assert meta["systems"]["chittu-story-v0-26m"]["counts"] == {"completion": 4, "requests": 6}
    assert meta["systems"]["tinystories-33m"]["counts"] == {"completion": 4}
    assert meta["prompts"]["completion"]["count"] == 2 and meta["prompts"]["requests"]["count"] == 3
    assert meta["decoding"]["seeds"] == [42, 43]
    assert json.loads((tmp_path / "meta.json").read_text()) == meta


def test_limit_caps_both_prompt_sets(tmp_path, fake_systems):
    generate.run_generate(fake_systems, PROMPTS, REQUESTS, tmp_path, seeds=(42,), limit=1)
    assert len(read_jsonl(tmp_path / "chittu-story-v0-26m" / "generations.jsonl")) == 2
