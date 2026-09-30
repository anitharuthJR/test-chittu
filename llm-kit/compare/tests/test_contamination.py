import json

from compare import contamination


def test_absent_corpus_is_not_run_never_clean(tmp_path):
    r = contamination.check(["Once upon a time"], tmp_path / "missing.jsonl")
    assert r["status"] == "not run" and "missing.jsonl" in r["reason"]


def test_planted_needle_is_found_and_clean_needle_is_not(tmp_path):
    corpus = tmp_path / "kept.jsonl"
    rows = [
        {"id": "r1", "story": "Once upon a time, there lived a bunny in a field. Her name was Lucy."},
        {"id": "r2", "story": "Tom had a red ball. He kicked it far."},
    ]
    corpus.write_text("".join(json.dumps(r) + "\n" for r in rows))
    needles = ["there lived a bunny in a field", "a dragon who is scared of the dark"]
    r = contamination.check(needles, corpus)
    assert r == {"status": "run", "records": 2, "needles": 2, "hits": {"there lived a bunny in a field": ["r1"]}}


def test_corpus_path_points_at_the_kept_file():
    assert contamination.corpus_path().name == "stories.kept.jsonl"
