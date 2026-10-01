import copy
import json

import pytest

from compare import landscape
from compare.paths import REPO_ROOT

FIXTURE = json.loads((REPO_ROOT / "comparisons" / "fixtures" / "example-landscape.json").read_text())


def test_fixture_validates():
    assert landscape.validate_landscape(FIXTURE) == []


@pytest.mark.parametrize("mutate", [
    lambda c: c["rows"][0]["cells"].pop("crisis"),                                        # a column missing
    lambda c: c["rows"][0]["cells"].__setitem__("extra", {"value": "x", "source": "https://a.b", "asOf": "2026-10-02"}),
    lambda c: c["rows"][1]["cells"]["crisis"].__setitem__("source", "http://example.com"),
    lambda c: c["rows"][1]["cells"]["crisis"].pop("asOf"),
    lambda c: c["systems"][1].__setitem__("isChittu", True),
    lambda c: c.__setitem__("caveats", []),
    lambda c: c.__setitem__("kind", "story"),
    lambda c: c["rows"][1].__setitem__("system", "unknown"),
])
def test_broken_variants_are_refused(mutate):
    c = copy.deepcopy(FIXTURE)
    mutate(c)
    assert landscape.validate_landscape(c) != []
