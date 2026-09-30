import os
import re

import pytest

from compare import systems
from compare.systems import REGISTRY, SystemSpec, by_id


class FakeTok:
    """Encodes each character to its code point; special tokens are large ints."""
    SPECIAL = {"<|user_start|>": 9001, "<|user_end|>": 9002, "<|assistant_start|>": 9003, "<|assistant_end|>": 9004}

    def get_bos_token_id(self):
        return 9000

    def encode_special(self, name):
        return self.SPECIAL[name]

    def encode(self, text):
        return [ord(c) for c in text]

    def decode(self, ids):
        return "".join(chr(i) for i in ids)


class FakeModel:
    """Yields a fixed token list, then a stop token if `stop_at` is set."""
    def __init__(self, tokens, stop_at=None):
        self.tokens, self.stop_at = tokens, stop_at

    def generate(self, ids, max_tokens, temperature=1.0, top_k=None, seed=42):
        for i, t in enumerate(self.tokens[:max_tokens]):
            if self.stop_at is not None and i == self.stop_at:
                yield 9004
                return
            yield t


def test_registry_has_six_systems_one_chittu_unique_ids_pinned_revisions():
    ids = [s.id for s in REGISTRY]
    assert len(ids) == 6 and len(set(ids)) == 6
    assert [s.id for s in REGISTRY if s.is_chittu] == ["chittu-story-v0-26m"]
    for s in REGISTRY:
        assert re.fullmatch(r"[0-9a-f]{40}", s.revision), s.id
        assert s.source.startswith("huggingface:")
        assert set(s.probes) <= {"completion", "requests"} and s.probes
        assert s.kind in ("chittu", "gptneo")
    assert by_id("tinystories-33m").repo == "roneneldan/TinyStories-33M"
    with pytest.raises(KeyError):
        by_id("nope")


def test_probes_match_the_design():
    assert by_id("chittu-story-v0-26m").probes == ("completion", "requests")
    for sid in ("tinystories-1m", "tinystories-3m", "tinystories-8m", "tinystories-33m"):
        assert by_id(sid).probes == ("completion",)
    assert by_id("tinystories-instruct-33m").probes == ("requests",)


def test_decoding_is_the_spec():
    assert systems.DECODING == {"temperature": 0.6, "top_k": 50, "seeds": (42, 43, 44), "completion_tokens": 200, "request_tokens": 400}


def test_chittu_completion_ids_start_with_bos_and_nothing_else():
    tok = FakeTok()
    assert systems.chittu_completion_ids(tok, "ab") == [9000, 97, 98]


def test_chittu_request_ids_mirror_the_public_loader():
    tok = FakeTok()
    assert systems.chittu_request_ids(tok, "hi") == [9000, 9001, 104, 105, 9002, 9003]


def test_run_nanochat_reports_ended_only_on_a_stop_token():
    tok = FakeTok()
    g = systems.run_nanochat(FakeModel([104, 105, 106]), tok, [9000], 3, 42, {9004})
    assert g == systems.Generation("hij", False)
    g2 = systems.run_nanochat(FakeModel([104, 105, 106], stop_at=2), tok, [9000], 10, 42, {9004})
    assert g2 == systems.Generation("hi", True)


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("COMPARE_REAL") != "1", reason="loads real models; set COMPARE_REAL=1")
def test_real_chittu_and_smallest_gptneo_generate():
    c = systems.load_system(by_id("chittu-story-v0-26m"))
    assert c.params == 26345726
    g = c.request("tell me a story about a brave little sparrow", 42)
    assert len(g.text) > 20
    n = systems.load_system(by_id("tinystories-1m"))
    assert n.params > 0
    g2 = n.complete("Once upon a time, there was a little bunny who", 42)
    assert len(g2.text) > 0
