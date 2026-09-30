from compare import io_utils, paths


def test_nanochat_dir_is_the_subtree():
    assert (paths.NANOCHAT_DIR / "nanochat" / "gpt.py").is_file()
    assert (paths.NANOCHAT_DIR / "chittu" / "story_eval.py").is_file()


def test_repo_root_holds_the_cards_dir():
    assert (paths.REPO_ROOT / "comparisons" / "fixtures" / "example-card.json").is_file()


def test_ensure_nanochat_on_path_is_idempotent():
    import sys
    paths.ensure_nanochat_on_path()
    paths.ensure_nanochat_on_path()
    assert sys.path.count(str(paths.NANOCHAT_DIR)) == 1


def test_out_root_honours_env(monkeypatch, tmp_path):
    monkeypatch.setenv("CHITTU_COMPARE_DIR", str(tmp_path))
    assert paths.out_root() == tmp_path


def test_jsonl_round_trip_and_pct(tmp_path):
    p = tmp_path / "x.jsonl"
    assert io_utils.write_jsonl(p, [{"a": 1}, {"b": "ü"}]) == 2
    assert io_utils.read_jsonl(p) == [{"a": 1}, {"b": "ü"}]
    assert io_utils.pct(1, 3) == 33.3
    assert io_utils.pct(0, 0) == 0.0
