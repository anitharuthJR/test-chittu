from __future__ import annotations

import importlib
import json
from collections import Counter

import pyarrow.parquet as pq
import pytest

from chittu import build_dataset as bd
from chittu.common import sha256_text, write_jsonl


def kept_rec(i: int, *, words=("sun", "hat", "run"), summary="A summary.") -> dict:
    return {"id": sha256_text(str(i))[:16], "story": f"Story number {i}. The end.", "words": list(words), "features": [], "summary": summary, "source": "GPT-4"}


def test_split_is_seeded_and_holds_out_min_val():
    recs = [kept_rec(i) for i in range(20)]
    train, val = bd.split_records(recs, val_min=3)
    assert (len(train), len(val)) == (17, 3)
    assert (train, val) == bd.split_records(recs, val_min=3)
    assert {r["id"] for r in train} | {r["id"] for r in val} == {r["id"] for r in recs}
    assert [r["id"] for r in train] != [r["id"] for r in recs[:17]]  # actually shuffled


def test_shards_carry_text_and_val_is_exactly_one_last_file(tmp_path, monkeypatch):
    monkeypatch.setattr(bd, "SHARD_ROWS", 3)
    train = [kept_rec(i) for i in range(7)]
    val = [kept_rec(100 + i) for i in range(2)]
    paths = bd.write_shards(train, val, tmp_path)
    assert [p.name for p in paths] == ["shard_00000.parquet", "shard_00001.parquet", "shard_00002.parquet", "shard_00003.parquet"]
    last = pq.ParquetFile(paths[-1])
    assert last.schema.names == ["text"] and last.metadata.num_rows == 2
    assert pq.read_table(paths[0]).column("text").to_pylist() == [r["story"] for r in train[:3]]
    assert pq.ParquetFile(paths[0]).metadata.row_group(0).num_rows <= bd.ROW_GROUP


def test_write_shards_deletes_stale_shards_first(tmp_path, monkeypatch):
    """A stale extra shard would otherwise become nanochat's validation file — it takes
    the last file by sorted name."""
    monkeypatch.setattr(bd, "SHARD_ROWS", 3)
    stale = tmp_path / "shard_00099.parquet"
    stale.write_bytes(b"not a real parquet file")
    train = [kept_rec(i) for i in range(7)]
    val = [kept_rec(100 + i) for i in range(2)]
    paths = bd.write_shards(train, val, tmp_path)
    assert not stale.exists()
    assert sorted(p.name for p in tmp_path.glob("shard_*.parquet")) == sorted(p.name for p in paths)


def test_nanochat_reads_our_shards(kit_env):
    """The real consumer: nanochat.dataset must yield the validation stories from the LAST shard."""
    _, data = kit_env
    bd.write_shards([kept_rec(i) for i in range(4)], [kept_rec(9)], data)
    import nanochat.dataset as ds

    importlib.reload(ds)
    assert list(ds.parquets_iter_batched("val")) == [["Story number 9. The end."]]
    assert sum(len(b) for b in ds.parquets_iter_batched("train")) == 4


def test_render_prompt_buckets_and_word_joining():
    words = dict(kept_rec(0, words=("rescue", "crown", "quiet")), id="00000000aaaaaaaa")  # bucket 0
    assert bd.render_prompt(words) == "Tell me a story using the words rescue, crown and quiet."
    assert bd.render_prompt(dict(words, words=["rescue", "crown"])) == "Tell me a story using the words rescue and crown."
    assert bd.render_prompt(dict(words, words=["rescue"])) == "Tell me a story using the words rescue."
    assert bd.render_prompt(dict(words, words=[])) == "Tell me a story about this: A summary."  # no words falls through
    assert bd.render_prompt(dict(words, id="0000002daaaaaaaa")).startswith("Tell me a story about this:")  # 45
    assert bd.render_prompt(dict(words, id="0000005aaaaaaaaa")) == "Tell me a story."  # 90
    assert bd.render_prompt(dict(words, id="0000002daaaaaaaa", summary="")) == "Tell me a story."


def test_prompt_mix_is_about_45_45_10():
    def kind(prompt: str) -> str:
        return "words" if "using the words" in prompt else "summary" if "about this:" in prompt else "bare"

    kinds = Counter(kind(bd.render_prompt(kept_rec(i))) for i in range(1000))
    assert 390 <= kinds["words"] <= 510 and 390 <= kinds["summary"] <= 510 and 60 <= kinds["bare"] <= 140


def test_to_pair_shape():
    pair = bd.to_pair(dict(kept_rec(1), id="0000005aaaaaaaaa"))
    assert pair == {"messages": [{"role": "user", "content": "Tell me a story."}, {"role": "assistant", "content": "Story number 1. The end."}]}


def test_min_train_aborts_instead_of_running_smaller(kit_env):
    _, data = kit_env
    write_jsonl(data / "stories.kept.jsonl", [kept_rec(i) for i in range(5)])
    with pytest.raises(SystemExit, match="--min-train"):
        bd.build(data / "stories.kept.jsonl", data, min_train=10, sft_max=10, sft_val_max=2, val_min=1)


def test_manifest_is_identical_across_two_builds(tmp_path):
    kept = tmp_path / "kept.jsonl"
    write_jsonl(kept, [kept_rec(i) for i in range(30)])
    m1 = bd.build(kept, tmp_path / "a", min_train=1, sft_max=5, sft_val_max=2, val_min=3)
    m2 = bd.build(kept, tmp_path / "b", min_train=1, sft_max=5, sft_val_max=2, val_min=3)
    assert (m1["dataset_sha256"], m1["shards"], m1["sft_files"]) == (m2["dataset_sha256"], m2["shards"], m2["sft_files"])
    assert m1["counts"] == {"train": 27, "val": 3, "sft_train": 5, "sft_val": 2, "sft_skipped_long": 0}
    assert len(m1["dataset_sha256"]) == 64 and m1["nanochat_upstream"] == "92d63d4e8bb4df75c3b71618f31ddde2378b2bcd"
    assert m1["sweep"] is None and m1["prepare"] is None
    on_disk = json.loads((tmp_path / "a" / "MANIFEST.json").read_text(encoding="utf-8"))
    assert on_disk["dataset_sha256"] == m1["dataset_sha256"]
    assert (tmp_path / "a" / "MANIFEST.json").read_bytes().endswith(b"\n")
    pair = json.loads((tmp_path / "a" / "stories.sft.train.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert [m["role"] for m in pair["messages"]] == ["user", "assistant"]


def test_build_folds_in_the_sweep_report(tmp_path):
    kept = tmp_path / "kept.jsonl"
    write_jsonl(kept, [kept_rec(i) for i in range(6)])
    sweep = tmp_path / "sweep.json"
    sweep.write_text(json.dumps({"input": "x", "total": 9, "kept": 6, "dropped": {"L1:crisis": 3, "L6": 0}, "samples": {}}))
    m = bd.build(kept, tmp_path / "out", min_train=1, sft_max=3, sft_val_max=1, val_min=1, sweep_report=sweep)
    assert m["sweep"] == {"total": 9, "kept": 6, "dropped": {"L1:crisis": 3, "L6": 0}} and len(m["sweep_report_sha256"]) == 64


def test_main_requires_kept_and_skips_when_built(kit_env, capsys):
    _, data = kit_env
    with pytest.raises(SystemExit, match="story:sweep"):
        bd.main([])
    (data / "MANIFEST.json").write_text("{}")
    assert bd.main([]) == 0 and "skipping" in capsys.readouterr().out


def test_main_rebuilds_when_sft_max_chars_changed(kit_env, capsys):
    _, data = kit_env
    write_jsonl(data / "stories.kept.jsonl", [kept_rec(i) for i in range(5)])
    (data / "MANIFEST.json").write_text(json.dumps({"split": {"sft_max_chars": 999}}))
    assert bd.main(["--min-train", "1", "--val-min", "1"]) == 0
    out = capsys.readouterr().out
    assert "exists but was built with --sft-max-chars 999; rebuilding with 1600" in out
    manifest = json.loads((data / "MANIFEST.json").read_text(encoding="utf-8"))
    assert manifest["split"]["sft_max_chars"] == 1600


def test_sft_pairs_skip_records_longer_than_the_char_cap_and_count_them(tmp_path):
    recs = [kept_rec(i) for i in range(12)]
    recs[3]["story"] = "x" * 2000  # longer than any cap we would ever set
    kept = tmp_path / "kept.jsonl"
    write_jsonl(kept, recs)
    m = bd.build(kept, tmp_path / "out", min_train=1, sft_max=100, sft_val_max=100, val_min=2, sft_max_chars=1600)
    pairs = [json.loads(l) for l in (tmp_path / "out" / "stories.sft.train.jsonl").read_text(encoding="utf-8").splitlines()]
    assert all(len(p["messages"][0]["content"]) + len(p["messages"][1]["content"]) <= 1600 for p in pairs)
    assert m["split"]["sft_max_chars"] == 1600
    assert m["counts"]["sft_skipped_long"] == 1
    assert m["counts"]["sft_train"] + m["counts"]["sft_val"] == 11


def test_sft_cap_still_fills_sft_max_from_later_records(tmp_path):
    recs = [kept_rec(i) for i in range(10)]
    for i in range(3):
        recs[i]["story"] = "y" * 3000
    kept = tmp_path / "kept.jsonl"
    write_jsonl(kept, recs)
    m = bd.build(kept, tmp_path / "out", min_train=1, sft_max=4, sft_val_max=1, val_min=1, sft_max_chars=1600)
    assert m["counts"]["sft_train"] == 4  # the cap skips, it does not truncate the quota
    assert m["counts"]["sft_skipped_long"] == 3  # every long record in the pool, not only those seen before the quota filled
