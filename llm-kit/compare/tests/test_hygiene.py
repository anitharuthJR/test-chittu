import pytest

from compare import hygiene

GENS = [
    {"id": "s:completion:0:42", "probe": "completion", "ended": True},
    {"id": "s:completion:0:43", "probe": "completion", "ended": False},
    {"id": "s:requests:0:42", "probe": "requests", "ended": True},
]
VERDICTS = [
    {"id": "s:completion:0:42", "keep": True},
    {"id": "s:completion:0:43", "keep": False, "gate": "L1", "kind": "unsafe"},
    {"id": "s:requests:0:42", "keep": False, "gate": "L6"},
]
REPORT = {"total": 3, "kept": 1, "dropped": {"L1:unsafe": 1, "L6": 1}}


def test_sweep_command_uses_the_text_field_and_the_verdicts_sink():
    cmd = hygiene.sweep_command("g.jsonl", "k.jsonl", "r.json", "v.jsonl")
    assert cmd == ["pnpm", "story:sweep", "--", "g.jsonl", "k.jsonl", "r.json", "--fields", "text", "--verdicts", "v.jsonl"]


def test_check_instrument_accepts_agreeing_counts():
    hygiene.check_instrument(REPORT, GENS, VERDICTS)


@pytest.mark.parametrize("report", [
    {"total": 2, "kept": 1, "dropped": {}},          # judged fewer texts than were generated
    {"total": 3, "kept": 2, "dropped": {}},          # kept count disagrees with the verdicts
])
def test_check_instrument_refuses_disagreement(report):
    with pytest.raises(hygiene.InstrumentError):
        hygiene.check_instrument(report, GENS, VERDICTS)


def test_check_instrument_refuses_a_missing_verdict():
    with pytest.raises(hygiene.InstrumentError):
        hygiene.check_instrument(REPORT, GENS, VERDICTS[:2])


def test_fold_is_per_probe():
    f = hygiene.fold(GENS, VERDICTS)
    assert f["completion"] == {"total": 2, "clean": 1, "ended": 1, "by_kind": {"L1:unsafe": 1}, "clean_pct": 50.0, "ended_pct": 50.0}
    assert f["requests"] == {"total": 1, "clean": 0, "ended": 1, "by_kind": {"L6": 1}, "clean_pct": 0.0, "ended_pct": 100.0}


def test_verdict_label():
    assert hygiene.verdict_label(VERDICTS[0]) == "clean"
    assert hygiene.verdict_label(VERDICTS[1]) == "L1:unsafe"
    assert hygiene.verdict_label(VERDICTS[2]) == "L6"
