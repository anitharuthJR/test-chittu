# Chittu comparison cards, drop 1 (chittu-repo half) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the two drop-1 cards behind tulifo.com's `/chittu/compare` — the story model against TinyStories (measured) and the landscape table (sourced) — as `comparisons/cards/*.{json,md}`, from a runner that loads every model from Hugging Face and grades with Chittu's real guards.

**Architecture:** A small Python project at `llm-kit/compare/` (its own uv lockfile; nothing upstream patched) generates stories from six systems under identical decoding, shells out to the existing `pnpm story:sweep` (extended with a per-record `--verdicts` file) for L1 + L6 hygiene, writes a blind sample for the human read, and assembles a card that a Python validator holds to the same rules as the website's Zod schema. The landscape card is hand-authored JSON with a public source on every cell. Spec: `docs/superpowers/specs/2026-09-29-chittu-comparison-page-design.md` (§2, §5, §6, §9).

**Tech Stack:** Python ≥ 3.10 under uv (`torch==2.9.1`, `transformers`, `safetensors`, `huggingface_hub`, `tiktoken`, `rustbpe`, `filelock`, `kernels`, `numpy`, `pytest`); the nanochat subtree's model code imported from `llm-kit/nanochat`; TypeScript (Vitest) for the sweep extension; `pnpm verify`.

## Global Constraints

- The page renders cards and holds no numbers of its own; a measurement that has not run has no card (spec §2.1).
- Chittu's models are loaded from Hugging Face exactly as a stranger would: `snapshot_download` + the repo's own `load.py`, revision pinned (spec §2.1 rule 5).
- Decoding is identical for every system: temperature 0.6, top-k 50, seeds 42/43/44; 200 new tokens for completions, 400 for requests (spec §6.2).
- Story generations are published verbatim, each labelled with its L1 kind or L6 failure (spec §2.5).
- The card step refuses unless the sweep judged exactly as many texts as were generated (spec §6.4, instrument check).
- Raw generations and reports live under `~/.cache/chittu-compare/<id>-<date>/`, never in the tree; only `comparisons/cards/*` is committed (spec §2.2).
- Only two nanochat upstream files are patched today (`nanochat/dataset.py`, `scripts/chat_sft.py`); this plan patches none. `llm-kit/nanochat/pyproject.toml` and `uv.lock` are not touched (CLAUDE.md).
- Never run `python -m nanochat.dataset` (CLAUDE.md).
- Every card has ≥ 1 caveat, a denominator on every metric, exactly one `isChittu` system, and `imported: null` (spec §2.3).
- Every landscape cell has an `https://` source and an `asOf` date; `"not stated"` is the only way to record silence (spec §5).
- Card `id`s: `story-vs-tinystories`, `landscape`. Card file names: `<id>-<date>.json` / `.md`; `links.card` is `/chittu/cards/<id>-<date>.md`.
- Pinned revisions (Hugging Face commit SHAs, resolved 2026-09-29): `Tulifo/chittu-story-v0-26m` `4f11284f8ebc19348ce2885bfea66eb13c8717cc`; `roneneldan/TinyStories-1M` `77f1b168e219585646439073245fe87e56b3023e`; `-3M` `cfaf26ec85ecdfc1bd7c2638104cce55cb67f894`; `-8M` `8612e3b15c66ffa94eaa6ee0de5c96edd2d630af`; `-33M` `2ad0a164221b7c4d21cac7c46aec74f6f98dbfc8`; `-Instruct-33M` `a16a5748e848e534c3efa91b4d96dd752db27e5f`; tokenizer `EleutherAI/gpt-neo-125M` `21def0189f5705e2521767faed922f1f15e7d7db`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Work stays on branch `arun/chittu-llm-comparison-1d7ee4` in this worktree; never commit to `main`.
- Run Python from `llm-kit/compare` as `uv run --frozen python -m pytest -q` / `uv run --frozen python story_compare.py …`. Run pnpm from the repo root.

---

## File structure

```
llm-kit/compare/
  pyproject.toml, uv.lock, .python-version, README.md
  story_compare.py            CLI: generate | sweep | blind | card   (argv only; logic in compare/)
  compare/__init__.py
  compare/paths.py            NANOCHAT_DIR, REPO_ROOT, ensure_nanochat_on_path(), out_root()
  compare/io_utils.py         read_jsonl(), write_jsonl(), pct()
  compare/systems.py          SystemSpec, REGISTRY, DECODING, Generation, ChittuSystem, GptNeoSystem, load_system()
  compare/prompts.py          load_completion_prompts(), load_requests(), to_summary(), instruct_prompt()
  compare/generate.py         run_generate()
  compare/hygiene.py          sweep_command(), run_sweep(), check_instrument(), fold()
  compare/blind.py            make_blind(), read_findings(), unblind()
  compare/contamination.py    check()
  compare/card.py             validate(), build_card(), render_md()
  tests/conftest.py, tests/test_*.py
apps/api/src/story-corpus/stream.ts        sweepStream gains an optional verdicts sink
apps/api/src/story-corpus/stream.test.ts   one new test
apps/api/scripts/story-sweep.ts            --verdicts <path>
apps/api/src/verify-compare-lane.test.ts   pins the new verify lane
scripts/verify.sh                          the "compare kit" lane
comparisons/cards/story-vs-tinystories-<date>.{json,md}
comparisons/cards/landscape-<date>.{json,md}
```

---

### Task 1: The compare project scaffold

**Files:**
- Create: `llm-kit/compare/pyproject.toml`, `llm-kit/compare/.python-version`, `llm-kit/compare/README.md`, `llm-kit/compare/compare/__init__.py`, `llm-kit/compare/compare/paths.py`, `llm-kit/compare/compare/io_utils.py`, `llm-kit/compare/tests/conftest.py`, `llm-kit/compare/tests/test_paths.py`
- Generated: `llm-kit/compare/uv.lock`

**Interfaces:**
- Produces: `compare.paths.NANOCHAT_DIR: Path`, `compare.paths.REPO_ROOT: Path`, `compare.paths.ensure_nanochat_on_path() -> None`, `compare.paths.out_root() -> Path`; `compare.io_utils.read_jsonl(path) -> list[dict]`, `compare.io_utils.write_jsonl(path, rows) -> int`, `compare.io_utils.pct(n, total) -> float` (one decimal).

- [ ] **Step 1: Write the project files**

`llm-kit/compare/pyproject.toml`:

```toml
[project]
name = "chittu-compare"
version = "0.1.0"
description = "Runs the comparisons behind tulifo.com/chittu/compare and writes their cards"
requires-python = ">=3.10"
dependencies = [
    "torch==2.9.1",
    "transformers>=4.45",
    "safetensors>=0.4",
    "huggingface-hub>=0.34",
    "tiktoken>=0.11.0",
    "rustbpe>=0.1.0",
    "filelock>=3.19.0",
    "kernels>=0.11.7",
    "numpy>=1.26.0",
]

[dependency-groups]
dev = ["pytest>=8.0.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = ["slow: loads the real models from Hugging Face; run with COMPARE_REAL=1"]
```

`llm-kit/compare/.python-version`:

```
3.10
```

`llm-kit/compare/compare/__init__.py`: empty file.

`llm-kit/compare/compare/paths.py`:

```python
"""Where things are. The nanochat subtree is imported, never copied."""
from __future__ import annotations

import os
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]   # llm-kit/compare
NANOCHAT_DIR = PROJECT_DIR.parent / "nanochat"      # llm-kit/nanochat (git subtree)
REPO_ROOT = PROJECT_DIR.parents[1]                  # the chittu repo


def ensure_nanochat_on_path() -> None:
    """`nanochat.gpt`, `nanochat.tokenizer` and the `chittu` kit live in the subtree."""
    p = str(NANOCHAT_DIR)
    if p not in sys.path:
        sys.path.insert(0, p)


def out_root() -> Path:
    """Raw generations and reports live here, never in the tree."""
    return Path(os.environ.get("CHITTU_COMPARE_DIR") or os.path.expanduser("~/.cache/chittu-compare"))
```

`llm-kit/compare/compare/io_utils.py`:

```python
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable


def read_jsonl(path: str | Path) -> list[dict]:
    rows: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: str | Path, rows: Iterable[dict]) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    return n


def pct(n: int, total: int) -> float:
    return 0.0 if total == 0 else round(100.0 * n / total, 1)
```

`llm-kit/compare/tests/conftest.py`:

```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
```

`llm-kit/compare/README.md`:

```markdown
# chittu-compare — the runner behind tulifo.com/chittu/compare

Design: `docs/superpowers/specs/2026-09-29-chittu-comparison-page-design.md` §6.
Its own uv project so nothing in `../nanochat` is patched; the subtree's model code is
imported from there at run time.

    uv sync --frozen --group dev
    uv run --frozen python -m pytest -q                 # fast tests (no models)
    COMPARE_REAL=1 uv run --frozen python -m pytest -q  # also loads the real models

    uv run --frozen python story_compare.py generate --out ~/.cache/chittu-compare/story-vs-tinystories-<date>
    uv run --frozen python story_compare.py sweep    --out <same>     # pnpm story:sweep per system, from the repo root
    uv run --frozen python story_compare.py blind    --out <same>     # human-read sample + key
    uv run --frozen python story_compare.py card     --out <same> [--human-read <same>/human-read/FINDINGS.md]

The card step refuses unless the sweep judged exactly as many texts as were generated.
Raw generations never enter the tree; only `comparisons/cards/*` is committed.
```

- [ ] **Step 2: Write the failing test**

`llm-kit/compare/tests/test_paths.py`:

```python
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
```

- [ ] **Step 3: Create the environment and run the test to verify it fails**

```bash
cd llm-kit/compare && uv lock && uv sync --frozen --group dev && uv run --frozen python -m pytest -q
```

Expected: `uv lock` writes `uv.lock`; pytest reports errors for `test_paths.py` because `compare.paths` and `compare.io_utils` do not exist yet — if you wrote the module files in step 1 already, the run is green; that is acceptable for a scaffold task, but confirm all five tests ran.

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q
```

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare
git commit -m "compare: the runner's own uv project, paths and jsonl helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Systems — the registry and the two loaders

**Files:**
- Create: `llm-kit/compare/compare/systems.py`, `llm-kit/compare/tests/test_systems.py`

**Interfaces:**
- Consumes: `compare.paths.ensure_nanochat_on_path`.
- Produces: `DECODING: dict`; `SystemSpec` (frozen dataclass: `id, label, is_chittu, source, revision, probes: tuple[str, ...], kind: "chittu"|"gptneo", notes: str|None`, property `repo`); `REGISTRY: tuple[SystemSpec, ...]`; `GPTNEO_TOKENIZER: tuple[str, str]`; `Generation(text: str, ended: bool)`; `by_id(system_id) -> SystemSpec`; `chittu_completion_ids(tok, text) -> list[int]`; `chittu_request_ids(tok, text) -> list[int]`; `run_nanochat(model, tok, ids, max_tokens, seed, stop_ids) -> Generation`; classes `ChittuSystem`, `GptNeoSystem` with `.spec`, `.params`, `.complete(prompt, seed) -> Generation`, `.request(request, seed) -> Generation`; `load_system(spec) -> ChittuSystem | GptNeoSystem`.

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_systems.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_systems.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.systems'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/systems.py`:

```python
"""
The six systems, and how each is loaded and sampled.

Rule 5 of the design (§2.1): Chittu's model is loaded exactly as a stranger would load it —
`snapshot_download` at a pinned revision, then the repo's own `load.py`. The TinyStories
models load through transformers with the tokenizer their card names. Decoding is one
constant for every system.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path

from .paths import ensure_nanochat_on_path

DECODING = {"temperature": 0.6, "top_k": 50, "seeds": (42, 43, 44), "completion_tokens": 200, "request_tokens": 400}

GPTNEO_TOKENIZER = ("EleutherAI/gpt-neo-125M", "21def0189f5705e2521767faed922f1f15e7d7db")


@dataclass(frozen=True)
class SystemSpec:
    id: str
    label: str
    is_chittu: bool
    source: str            # "huggingface:<repo>"
    revision: str          # Hub commit sha, pinned
    probes: tuple[str, ...]
    kind: str              # "chittu" | "gptneo"
    notes: str | None = None

    @property
    def repo(self) -> str:
        return self.source.split(":", 1)[1]


REGISTRY: tuple[SystemSpec, ...] = (
    SystemSpec(
        "chittu-story-v0-26m", "Chittu story v0 (26M)", True,
        "huggingface:Tulifo/chittu-story-v0-26m", "4f11284f8ebc19348ce2885bfea66eb13c8717cc",
        ("completion", "requests"), "chittu",
        "base/ checkpoint for completions, root (SFT) checkpoint for requests",
    ),
    SystemSpec("tinystories-1m", "TinyStories-1M", False, "huggingface:roneneldan/TinyStories-1M",
               "77f1b168e219585646439073245fe87e56b3023e", ("completion",), "gptneo"),
    SystemSpec("tinystories-3m", "TinyStories-3M", False, "huggingface:roneneldan/TinyStories-3M",
               "cfaf26ec85ecdfc1bd7c2638104cce55cb67f894", ("completion",), "gptneo"),
    SystemSpec("tinystories-8m", "TinyStories-8M", False, "huggingface:roneneldan/TinyStories-8M",
               "8612e3b15c66ffa94eaa6ee0de5c96edd2d630af", ("completion",), "gptneo"),
    SystemSpec("tinystories-33m", "TinyStories-33M", False, "huggingface:roneneldan/TinyStories-33M",
               "2ad0a164221b7c4d21cac7c46aec74f6f98dbfc8", ("completion",), "gptneo"),
    SystemSpec(
        "tinystories-instruct-33m", "TinyStories-Instruct-33M", False,
        "huggingface:roneneldan/TinyStories-Instruct-33M", "a16a5748e848e534c3efa91b4d96dd752db27e5f",
        ("requests",), "gptneo",
        "receives each request through a Summary: adapter; it was never trained on a child's phrasing",
    ),
)


def by_id(system_id: str) -> SystemSpec:
    for s in REGISTRY:
        if s.id == system_id:
            return s
    raise KeyError(system_id)


@dataclass(frozen=True)
class Generation:
    text: str
    ended: bool   # the model stopped on its own before the token budget


# --- Chittu: the public loader, unchanged ------------------------------------------------

def chittu_completion_ids(tok, text: str) -> list[int]:
    """[bos] + encode(prompt) — what chittu/story_eval.py feeds the base checkpoint."""
    return [tok.get_bos_token_id(), *tok.encode(text)]


def chittu_request_ids(tok, text: str) -> list[int]:
    """Exactly what load.py's story() builds for the SFT checkpoint."""
    return [
        tok.get_bos_token_id(), tok.encode_special("<|user_start|>"), *tok.encode(text),
        tok.encode_special("<|user_end|>"), tok.encode_special("<|assistant_start|>"),
    ]


def run_nanochat(model, tok, ids: list[int], max_tokens: int, seed: int, stop_ids: set[int]) -> Generation:
    import torch
    out: list[int] = []
    ended = False
    with torch.no_grad():
        for t in model.generate(ids, max_tokens, temperature=DECODING["temperature"], top_k=DECODING["top_k"], seed=seed):
            if t in stop_ids:
                ended = True
                break
            out.append(t)
    return Generation(tok.decode(out), ended)


def _import_loader(path: Path):
    spec = importlib.util.spec_from_file_location("chittu_hf_loader", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ChittuSystem:
    def __init__(self, spec: SystemSpec):
        from huggingface_hub import snapshot_download
        ensure_nanochat_on_path()
        repo_dir = snapshot_download(spec.repo, revision=spec.revision)
        loader = _import_loader(Path(repo_dir) / "load.py")
        self.spec = spec
        self.sft, self.tok = loader.load(repo_dir)
        self.base, _ = loader.load(repo_dir, phase="base")
        self.params = sum(p.numel() for p in self.sft.parameters())
        self._request_stop = {self.tok.encode_special("<|assistant_end|>"), self.tok.get_bos_token_id()}

    def complete(self, prompt: str, seed: int) -> Generation:
        return run_nanochat(self.base, self.tok, chittu_completion_ids(self.tok, prompt),
                            DECODING["completion_tokens"], seed, {self.tok.get_bos_token_id()})

    def request(self, request: str, seed: int) -> Generation:
        return run_nanochat(self.sft, self.tok, chittu_request_ids(self.tok, request),
                            DECODING["request_tokens"], seed, self._request_stop)


# --- TinyStories: GPT-Neo through transformers -----------------------------------------

class GptNeoSystem:
    def __init__(self, spec: SystemSpec):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.spec = spec
        self.tok = AutoTokenizer.from_pretrained(GPTNEO_TOKENIZER[0], revision=GPTNEO_TOKENIZER[1])
        self.model = AutoModelForCausalLM.from_pretrained(spec.repo, revision=spec.revision).eval()
        self.params = sum(p.numel() for p in self.model.parameters())

    def complete(self, prompt: str, seed: int) -> Generation:
        return self._sample(prompt, DECODING["completion_tokens"], seed)

    def request(self, request: str, seed: int) -> Generation:
        from .prompts import instruct_prompt
        return self._sample(instruct_prompt(request), DECODING["request_tokens"], seed)

    def _sample(self, text: str, max_new: int, seed: int) -> Generation:
        import torch
        torch.manual_seed(seed)
        ids = self.tok(text, return_tensors="pt").input_ids
        with torch.no_grad():
            out = self.model.generate(
                ids, do_sample=True, temperature=DECODING["temperature"], top_k=DECODING["top_k"],
                max_new_tokens=max_new, pad_token_id=self.tok.eos_token_id,
            )
        new = out[0, ids.shape[1]:]
        eos = self.tok.eos_token_id
        hits = (new == eos).nonzero()
        ended = hits.numel() > 0
        if ended:
            new = new[: int(hits[0])]
        return Generation(self.tok.decode(new, skip_special_tokens=True), ended)


def load_system(spec: SystemSpec):
    if spec.kind == "chittu":
        return ChittuSystem(spec)
    if spec.kind == "gptneo":
        return GptNeoSystem(spec)
    raise ValueError(f"unknown system kind {spec.kind!r}")
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_systems.py
```

Expected: `6 passed, 1 skipped` (the slow test is skipped without `COMPARE_REAL=1`). `test_systems.py` imports `compare.prompts` lazily only inside `GptNeoSystem.request`, so the missing prompts module does not break these tests.

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/compare/systems.py llm-kit/compare/tests/test_systems.py
git commit -m "compare: the six systems, pinned revisions, and the two loaders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Prompts and the Instruct adapter

**Files:**
- Create: `llm-kit/compare/compare/prompts.py`, `llm-kit/compare/tests/test_prompts.py`

**Interfaces:**
- Consumes: `compare.paths.ensure_nanochat_on_path`; from the subtree, `chittu.common.ensure_source(name) -> Path` and `chittu.story_eval.load_eval_prompts(path) -> list[str]`, `chittu.story_eval.load_requests() -> list[str]`.
- Produces: `WRAPPERS: tuple[str, ...]`, `INSTRUCT_TEMPLATE: str`, `to_summary(request: str) -> str`, `instruct_prompt(request: str) -> str`, `load_completion_prompts() -> list[str]`, `load_requests() -> list[str]`, `REQUESTS_PATH: Path`, `PROMPTS_SOURCE_NAME = "Evaluation prompts.yaml"`.

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_prompts.py`:

```python
import pytest

from compare import prompts


@pytest.mark.parametrize("request_, summary", [
    ("tell me a story about a dog who wants to fly", "A story about a dog who wants to fly."),
    ("can you tell me a bedtime story", "A bedtime story."),
    ("a story about a brave little sparrow", "A story about a brave little sparrow."),
    ("tell me a funny story about a cat and a hat", "A funny story about a cat and a hat."),
    ("story about a girl who finds a shiny stone", "A story about a girl who finds a shiny stone."),
    ("a story with a boat and a big wave please", "A story with a boat and a big wave."),
    ("can i have a story about a princess who likes bugs", "A story about a princess who likes bugs."),
    ("make a story about a train that goes really fast", "A story about a train that goes really fast."),
    ("can you make a story about the moon", "A story about the moon."),
    ("Tell me a story about RAIN?", "A story about rain."),
])
def test_to_summary_strips_only_the_request_wrapper(request_, summary):
    assert prompts.to_summary(request_) == summary


def test_to_summary_refuses_an_empty_result():
    with pytest.raises(ValueError):
        prompts.to_summary("tell me")


def test_instruct_prompt_is_the_dataset_layout():
    # Layout pinned from TinyStories-Instruct-valid.txt: field lines, then "Story: " and a newline.
    assert prompts.INSTRUCT_TEMPLATE == "Summary: {summary}\nStory: \n"
    assert prompts.instruct_prompt("tell me a story about rain") == "Summary: A story about rain.\nStory: \n"


def test_every_request_in_the_file_adapts():
    reqs = prompts.load_requests()
    assert len(reqs) == 20
    for r in reqs:
        s = prompts.to_summary(r)
        assert s[0].isupper() and s.endswith(".") and len(s) > 8, (r, s)


def test_the_paper_prompts_are_the_pinned_44():
    ps = prompts.load_completion_prompts()
    assert len(ps) == 44
    assert all(p.strip() for p in ps)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_prompts.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.prompts'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/prompts.py`:

```python
"""
The two prompt sets and the Instruct adapter.

TinyStories-Instruct was trained on `Features:` / `Words:` / `Summary:` / `Random sentence:` /
`Story:` records, never on a child's phrasing. We strip only the request WRAPPER ("tell me",
"can you make", …) and keep every descriptive word, so "tell me a funny story about a cat"
becomes `Summary: A funny story about a cat.` — the card prints the adapted prompt beside
every request (spec §6.3).
"""
from __future__ import annotations

from pathlib import Path

from .paths import NANOCHAT_DIR, ensure_nanochat_on_path

PROMPTS_SOURCE_NAME = "Evaluation prompts.yaml"
REQUESTS_PATH = NANOCHAT_DIR / "chittu" / "story_requests.txt"

# Longest first, so "can you tell me" wins over "tell me".
WRAPPERS: tuple[str, ...] = ("can you tell me", "can you make", "can i have", "i want", "tell me", "make")

# Pinned from TinyStories-Instruct-valid.txt (fields on their own lines, then "Story: " + newline).
INSTRUCT_TEMPLATE = "Summary: {summary}\nStory: \n"


def to_summary(request: str) -> str:
    s = " ".join(request.strip().lower().split()).rstrip("?.! ")
    if s.endswith(" please"):
        s = s[: -len(" please")].rstrip()
    for w in sorted(WRAPPERS, key=len, reverse=True):
        if s == w or s.startswith(w + " "):
            s = s[len(w):].strip()
            break
    if s.startswith("story"):
        s = "a " + s
    if not s:
        raise ValueError(f"nothing left of {request!r} after removing the request wrapper")
    return s[0].upper() + s[1:] + "."


def instruct_prompt(request: str) -> str:
    return INSTRUCT_TEMPLATE.format(summary=to_summary(request))


def load_completion_prompts() -> list[str]:
    ensure_nanochat_on_path()
    from chittu.common import ensure_source
    from chittu.story_eval import load_eval_prompts
    return load_eval_prompts(ensure_source(PROMPTS_SOURCE_NAME))


def load_requests(path: Path = REQUESTS_PATH) -> list[str]:
    ensure_nanochat_on_path()
    from chittu.story_eval import load_requests as _load
    return _load(path)
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_prompts.py
```

Expected: `14 passed`. (`load_completion_prompts` reads `~/.cache/nanochat-chittu/sources/Evaluation prompts.yaml`, present on this Mac; on a fresh machine `ensure_source` downloads and sha-verifies it.)

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/compare/prompts.py llm-kit/compare/tests/test_prompts.py
git commit -m "compare: the paper's prompts, the child requests, and the Instruct adapter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `generate` — every system, every probe, every seed

**Files:**
- Create: `llm-kit/compare/compare/generate.py`, `llm-kit/compare/tests/test_generate.py`
- Modify: `llm-kit/compare/tests/conftest.py` (add the fake system)

**Interfaces:**
- Consumes: `SystemSpec`, `Generation`, `DECODING` from `compare.systems`; `instruct_prompt` from `compare.prompts`; `write_jsonl` from `compare.io_utils`.
- Produces: `generation_id(system_id, probe, index, seed) -> str` (`"<system>:<probe>:<index>:<seed>"`); `adapted_prompt(spec, probe, text) -> str | None`; `run_generate(systems, prompts, requests, out_dir, *, seeds=DECODING["seeds"], limit=None) -> dict` writing `<out_dir>/<system_id>/generations.jsonl` (records `{id, system, probe, index, seed, prompt, adapted, text, chars, ended}`) and `<out_dir>/meta.json` (`{date, decoding, prompts: {completion: {count, source}, requests: {count, source}}, systems: {id: {label, is_chittu, source, revision, params, probes, notes, counts: {probe: n}}}, versions}`).

- [ ] **Step 1: Add the fake system to conftest and write the failing tests**

Append to `llm-kit/compare/tests/conftest.py`:

```python
import pytest

from compare.systems import Generation, SystemSpec


class FakeSystem:
    """Deterministic text per (probe, prompt, seed); `ended` is True on even seeds."""
    def __init__(self, spec: SystemSpec, params: int = 1234):
        self.spec, self.params = spec, params

    def complete(self, prompt: str, seed: int) -> Generation:
        return Generation(f"C|{self.spec.id}|{prompt[:12]}|{seed}", seed % 2 == 0)

    def request(self, request: str, seed: int) -> Generation:
        return Generation(f"R|{self.spec.id}|{request[:12]}|{seed}", seed % 2 == 0)


@pytest.fixture
def fake_systems():
    chittu = SystemSpec("chittu-story-v0-26m", "Chittu story v0 (26M)", True, "huggingface:Tulifo/chittu-story-v0-26m",
                        "4f11284f8ebc19348ce2885bfea66eb13c8717cc", ("completion", "requests"), "chittu", "two checkpoints")
    neo = SystemSpec("tinystories-33m", "TinyStories-33M", False, "huggingface:roneneldan/TinyStories-33M",
                     "2ad0a164221b7c4d21cac7c46aec74f6f98dbfc8", ("completion",), "gptneo")
    instruct = SystemSpec("tinystories-instruct-33m", "TinyStories-Instruct-33M", False,
                          "huggingface:roneneldan/TinyStories-Instruct-33M", "a16a5748e848e534c3efa91b4d96dd752db27e5f",
                          ("requests",), "gptneo", "adapter")
    return [FakeSystem(chittu), FakeSystem(neo), FakeSystem(instruct)]
```

`llm-kit/compare/tests/test_generate.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_generate.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.generate'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/generate.py`:

```python
"""Probe (a) completions and probe (b) requests, for every system that takes them, every seed."""
from __future__ import annotations

import json
import platform
from datetime import date
from pathlib import Path

from .io_utils import write_jsonl
from .prompts import PROMPTS_SOURCE_NAME, REQUESTS_PATH, instruct_prompt
from .systems import DECODING, SystemSpec


def generation_id(system_id: str, probe: str, index: int, seed: int) -> str:
    return f"{system_id}:{probe}:{index}:{seed}"


def adapted_prompt(spec: SystemSpec, probe: str, text: str) -> str | None:
    """What the model actually saw when it differs from what the child typed."""
    return instruct_prompt(text) if (probe == "requests" and spec.kind == "gptneo") else None


def _versions() -> dict:
    out = {"python": platform.python_version()}
    for name in ("torch", "transformers"):
        try:
            out[name] = __import__(name).__version__
        except Exception:  # noqa: BLE001 - a missing optional import is just "absent" in meta
            out[name] = None
    return out


def run_generate(systems, prompts: list[str], requests: list[str], out_dir: Path, *,
                 seeds=DECODING["seeds"], limit: int | None = None) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    prompts = prompts[:limit] if limit else prompts
    requests = requests[:limit] if limit else requests
    meta: dict = {
        "date": date.today().isoformat(),
        "decoding": {**DECODING, "seeds": list(seeds)},
        "prompts": {
            "completion": {"count": len(prompts), "source": f"TinyStories '{PROMPTS_SOURCE_NAME}' (sha256-pinned in chittu/SOURCES.json)"},
            "requests": {"count": len(requests), "source": str(REQUESTS_PATH.relative_to(REQUESTS_PATH.parents[3]))},
        },
        "systems": {},
        "versions": _versions(),
    }
    for system in systems:
        spec: SystemSpec = system.spec
        rows: list[dict] = []
        counts: dict[str, int] = {}
        for probe, items, fn in (("completion", prompts, system.complete), ("requests", requests, system.request)):
            if probe not in spec.probes:
                continue
            for index, text in enumerate(items):
                for seed in seeds:
                    g = fn(text, seed)
                    rows.append({
                        "id": generation_id(spec.id, probe, index, seed), "system": spec.id, "probe": probe,
                        "index": index, "seed": seed, "prompt": text, "adapted": adapted_prompt(spec, probe, text),
                        "text": g.text, "chars": len(g.text), "ended": g.ended,
                    })
                    counts[probe] = counts.get(probe, 0) + 1
        write_jsonl(out_dir / spec.id / "generations.jsonl", rows)
        meta["systems"][spec.id] = {
            "label": spec.label, "is_chittu": spec.is_chittu, "source": spec.source, "revision": spec.revision,
            "params": system.params, "probes": list(spec.probes), "notes": spec.notes, "counts": counts,
        }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_generate.py
```

Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/compare/generate.py llm-kit/compare/tests/test_generate.py llm-kit/compare/tests/conftest.py
git commit -m "compare: generate every cell once and write meta.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The sweep writes a verdict per record (`--verdicts`)

The sweep report carries counts and ten samples per kind; a public card must label every generation, so the sweep gains an optional per-record sink. Nothing about judging changes.

**Files:**
- Modify: `apps/api/src/story-corpus/stream.ts` (`sweepStream` gains a fourth parameter), `apps/api/scripts/story-sweep.ts` (`--verdicts <path>`)
- Test: `apps/api/src/story-corpus/stream.test.ts`

**Interfaces:**
- Produces: `sweepStream(input, output, fields, verdicts?: Writable)`; each verdict line is `{"id": string|null, "keep": true}` or `{"id", "keep": false, "gate": "L1", "kind": <L1Kind>}` or `{"id", "keep": false, "gate": "L6"}`. CLI: `pnpm story:sweep -- <in> <out> <report.json> --fields text --verdicts <verdicts.jsonl>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/story-corpus/stream.test.ts` (reuse the file's existing imports of `sweepStream`, `Readable`, `PassThrough`; add them if absent):

```ts
import { PassThrough, Readable } from 'node:stream';

describe('sweepStream --verdicts', () => {
  it('writes one verdict per record, kept and dropped alike, in input order', async () => {
    // A benign line and the PII line this file already uses for the L1 pii case.
    const lines = [
      JSON.stringify({ id: 'a', text: 'A kind fox shared his apple with the mouse.' }),
      JSON.stringify({ id: 'b', text: PII_STORY_LINE }),
    ];
    const kept = new PassThrough();
    const verdicts = new PassThrough();
    const keptOut: string[] = [];
    const verdictOut: string[] = [];
    kept.on('data', (c) => keptOut.push(String(c)));
    verdicts.on('data', (c) => verdictOut.push(String(c)));
    const report = await sweepStream(Readable.from([lines.join('\n') + '\n']), kept, ['text'], verdicts);
    const parsed = verdictOut.join('').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ id: 'a', keep: true });
    expect(parsed[1]).toMatchObject({ id: 'b', keep: false, gate: 'L1', kind: 'pii' });
    expect(report.total).toBe(2);
    expect(report.kept).toBe(1);
    expect(keptOut.join('')).toBe(lines[0] + '\n');
  });

  it('writes nothing when no verdict sink is given (existing behaviour)', async () => {
    const kept = new PassThrough();
    kept.on('data', () => undefined);
    const report = await sweepStream(Readable.from([JSON.stringify({ id: 'a', text: 'A kind fox.' }) + '\n']), kept, ['text']);
    expect(report.total).toBe(1);
  });
});
```

`PII_STORY_LINE` is the phone-number story line `sweep.test.ts` already uses for its L1 `pii` case — import or copy that exact string; do not write a new one by reading the pattern.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run --project server apps/api/src/story-corpus/stream.test.ts
```

Expected: FAIL — `sweepStream` ignores the fourth argument, so `parsed` has length 0 (`expected [] to have a length of 2`).

- [ ] **Step 3: Implement the sink in `stream.ts`**

Replace the `sweepStream` function:

```ts
export async function sweepStream(
  input: Readable, output: Writable, fields: readonly string[], verdicts?: Writable,
): Promise<Report> {
  const report = emptyReport(fields);
  let lineNo = 0;
  for await (const line of jsonlLines(input)) {
    lineNo += 1;
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`line ${lineNo}: not JSON`);
    }
    const idValue = record['id'];
    const id = typeof idValue === 'string' ? idValue : null;
    const text = joinFields(record, fields);
    const verdict = judgeStory(text);
    tally(report, id, verdict, text);
    if (verdicts !== undefined) {
      // One line per record, kept or not: the card labels EVERY generation, and the
      // report's ten samples per kind cannot do that.
      const row = verdict.keep
        ? { id, keep: true }
        : verdict.gate === 'L1' ? { id, keep: false, gate: 'L1', kind: verdict.kind } : { id, keep: false, gate: 'L6' };
      if (!verdicts.write(JSON.stringify(row) + '\n')) await once(verdicts, 'drain');
    }
    if (verdict.keep && !output.write(line + '\n')) await once(output, 'drain');
  }
  return report;
}
```

- [ ] **Step 4: Run the test and make sure it passes**

```bash
pnpm vitest run --project server apps/api/src/story-corpus/stream.test.ts
```

Expected: PASS (all tests in the file).

- [ ] **Step 5: Add `--verdicts` to the script**

In `apps/api/scripts/story-sweep.ts`: extend `Args` with `verdictsPath: string | null`, parse `--verdicts <path>` / `--verdicts=<path>` in `parseArgs` (default `null`), update `usage()` to `… [--fields story,summary] [--verdicts <verdicts.jsonl>]`, and in `main()`:

```ts
  const verdictsTmp = verdictsPath === null ? null : verdictsPath + '.tmp';
  const verdicts = verdictsTmp === null ? undefined : createWriteStream(verdictsTmp);
  const verdictsDone = verdicts === undefined
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => { verdicts.on('error', reject); verdicts.on('finish', resolve); });
  verdictsDone.catch(() => undefined);
  try {
    const report = await sweepStream(createReadStream(inPath, { encoding: 'utf8' }), out, fields, verdicts);
    out.end();
    await finished;
    if (verdicts !== undefined) { verdicts.end(); await verdictsDone; }
    // ... existing report + md writes ...
    renameSync(tmpPath, outPath);
    if (verdictsTmp !== null && verdictsPath !== null) renameSync(verdictsTmp, verdictsPath);
    // ... existing console lines, plus:
    if (verdictsPath !== null) console.log(`verdicts: ${verdictsPath}`);
  } catch (err) {
    out.destroy();
    verdicts?.destroy();
    rmSync(tmpPath, { force: true });
    if (verdictsTmp !== null) rmSync(verdictsTmp, { force: true });
    throw err;
  }
```

Then run the script end to end on a two-line file:

```bash
printf '%s\n' '{"id":"a","text":"A kind fox shared his apple."}' '{"id":"b","text":"The robot said: I am alive!"}' > /tmp/gens.jsonl
pnpm story:sweep -- /tmp/gens.jsonl /tmp/kept.jsonl /tmp/report.json --fields text --verdicts /tmp/verdicts.jsonl && cat /tmp/verdicts.jsonl
```

Expected: two verdict lines; the second is `{"id":"b","keep":false,"gate":"L6"}` (or an L1 kind if the lexicon fires first — either way `keep: false`); `report: /tmp/report.json + /tmp/report.md` and `verdicts: /tmp/verdicts.jsonl` printed.

- [ ] **Step 6: Typecheck, run the story-corpus suite, commit**

```bash
pnpm typecheck && pnpm vitest run --project server apps/api/src/story-corpus
git add apps/api/src/story-corpus/stream.ts apps/api/src/story-corpus/stream.test.ts apps/api/scripts/story-sweep.ts
git commit -m "story-sweep: an optional per-record verdicts file, so a card can label every generation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `hygiene` — run the sweep per system, check the instrument, fold per probe

**Files:**
- Create: `llm-kit/compare/compare/hygiene.py`, `llm-kit/compare/tests/test_hygiene.py`

**Interfaces:**
- Consumes: `read_jsonl`, `pct` from `compare.io_utils`; `REPO_ROOT` from `compare.paths`.
- Produces: `sweep_command(gens, kept, report, verdicts) -> list[str]`; `run_sweep(system_dir: Path, repo_root: Path = REPO_ROOT) -> dict` (runs the command with `cwd=repo_root`, returns the report JSON; files `kept.jsonl`, `sweep.json`, `sweep.md`, `verdicts.jsonl` beside `generations.jsonl`); `class InstrumentError(SystemExit)`; `check_instrument(report, generations, verdicts) -> None`; `fold(generations, verdicts) -> dict[str, dict]` per probe: `{total, clean, ended, by_kind: {DropKey: n}, clean_pct, ended_pct}`; `verdict_label(verdict) -> str` (`"clean"`, `"L1:pii"`, `"L6"`).

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_hygiene.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_hygiene.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.hygiene'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/hygiene.py`:

```python
"""
Hygiene = Chittu's real guards over every generation, via the existing sweep.

The instrument check is the point: a sweep that judged fewer texts than were generated, or
whose kept count disagrees with its own verdicts, is an instrument reporting on something
else (docs/chittu-status.md §8b). The card step refuses rather than publishing.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .io_utils import pct
from .paths import REPO_ROOT


class InstrumentError(SystemExit):
    pass


def sweep_command(gens, kept, report, verdicts) -> list[str]:
    return ["pnpm", "story:sweep", "--", str(gens), str(kept), str(report), "--fields", "text", "--verdicts", str(verdicts)]


def run_sweep(system_dir: Path, repo_root: Path = REPO_ROOT) -> dict:
    system_dir = Path(system_dir)
    cmd = sweep_command(system_dir / "generations.jsonl", system_dir / "kept.jsonl",
                        system_dir / "sweep.json", system_dir / "verdicts.jsonl")
    subprocess.run(cmd, cwd=repo_root, check=True)
    return json.loads((system_dir / "sweep.json").read_text(encoding="utf-8"))


def verdict_label(verdict: dict) -> str:
    if verdict["keep"]:
        return "clean"
    return f"L1:{verdict['kind']}" if verdict["gate"] == "L1" else "L6"


def check_instrument(report: dict, generations: list[dict], verdicts: list[dict]) -> None:
    if not (report["total"] == len(generations) == len(verdicts)):
        raise InstrumentError(
            f"instrument check failed: the sweep judged {report['total']} texts, "
            f"{len(generations)} generations were written, {len(verdicts)} verdicts came back"
        )
    kept = sum(1 for v in verdicts if v["keep"])
    if kept != report["kept"]:
        raise InstrumentError(f"instrument check failed: report says {report['kept']} kept, verdicts say {kept}")
    have = {v["id"] for v in verdicts}
    missing = [g["id"] for g in generations if g["id"] not in have]
    if missing:
        raise InstrumentError(f"instrument check failed: no verdict for {missing[:3]}{'…' if len(missing) > 3 else ''}")


def fold(generations: list[dict], verdicts: list[dict]) -> dict[str, dict]:
    by_id = {v["id"]: v for v in verdicts}
    out: dict[str, dict] = {}
    for g in generations:
        v = by_id.get(g["id"])
        if v is None:
            raise InstrumentError(f"no verdict for {g['id']}")
        p = out.setdefault(g["probe"], {"total": 0, "clean": 0, "ended": 0, "by_kind": {}})
        p["total"] += 1
        p["clean"] += 1 if v["keep"] else 0
        p["ended"] += 1 if g["ended"] else 0
        if not v["keep"]:
            key = verdict_label(v)
            p["by_kind"][key] = p["by_kind"].get(key, 0) + 1
    for p in out.values():
        p["clean_pct"] = pct(p["clean"], p["total"])
        p["ended_pct"] = pct(p["ended"], p["total"])
    return out
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_hygiene.py
```

Expected: `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/compare/hygiene.py llm-kit/compare/tests/test_hygiene.py
git commit -m "compare: hygiene through the real sweep, with the instrument check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `blind` — the human-read sample and its key

**Files:**
- Create: `llm-kit/compare/compare/blind.py`, `llm-kit/compare/tests/test_blind.py`

**Interfaces:**
- Consumes: `read_jsonl` from `compare.io_utils`; `<out>/meta.json` and `<out>/<system>/generations.jsonl` from Task 4.
- Produces: `make_blind(out_dir: Path, *, seed=7, per_system=10) -> Path` (writes `<out>/human-read/<letter>.md` per (probe, system) with letters running A, B, C… across probes, `<out>/human-read/key.json` = `{letter: {"system": id, "probe": probe}}`, and `<out>/human-read/FINDINGS.md` from `FINDINGS_TEMPLATE` if absent); `read_findings(path) -> dict | None` (`{reviewer, date, sample_size, findings}`; `None` when the header is blank; `ValueError` when half-filled); `unblind(text, key, labels) -> str` (replaces `System X` with `<label> (<probe>)`).

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_blind.py`:

```python
import json

import pytest

from compare import blind, generate

PROMPTS = [f"prompt {i}" for i in range(12)]
REQUESTS = [f"tell me a story about thing {i}" for i in range(12)]


def test_make_blind_letters_are_unique_across_probes_and_key_unblinds(tmp_path, fake_systems):
    generate.run_generate(fake_systems, PROMPTS, REQUESTS, tmp_path, seeds=(42,))
    human = blind.make_blind(tmp_path, seed=7, per_system=10)
    key = json.loads((human / "key.json").read_text())
    # chittu + 33m take completions (2 letters), chittu + instruct take requests (2 letters)
    assert sorted(key) == ["A", "B", "C", "D"]
    assert sorted((v["system"], v["probe"]) for v in key.values()) == sorted([
        ("chittu-story-v0-26m", "completion"), ("tinystories-33m", "completion"),
        ("chittu-story-v0-26m", "requests"), ("tinystories-instruct-33m", "requests"),
    ])
    for letter in key:
        md = (human / f"{letter}.md").read_text()
        assert md.count("### Item ") == 10
        assert "chittu" not in md.lower() and "tinystories" not in md.lower()   # blind
    assert (human / "FINDINGS.md").read_text().startswith("reviewer: \n")


def test_read_findings_blank_is_none_and_half_filled_raises(tmp_path):
    p = tmp_path / "FINDINGS.md"
    p.write_text(blind.FINDINGS_TEMPLATE)
    assert blind.read_findings(p) is None
    p.write_text("reviewer: Arun Kumar\ndate: \nsample_size: 40\n\nSystem A rambles.\n")
    with pytest.raises(ValueError):
        blind.read_findings(p)
    p.write_text("reviewer: Arun Kumar\ndate: 2026-10-03\nsample_size: 40\n\nSystem A rambles.\nSystem B ends well.\n")
    assert blind.read_findings(p) == {"reviewer": "Arun Kumar", "date": "2026-10-03", "sample_size": 40,
                                      "findings": "System A rambles.\nSystem B ends well."}


def test_unblind_replaces_letters_with_labels():
    key = {"A": {"system": "tinystories-33m", "probe": "completion"}, "B": {"system": "chittu-story-v0-26m", "probe": "requests"}}
    labels = {"tinystories-33m": "TinyStories-33M", "chittu-story-v0-26m": "Chittu story v0 (26M)"}
    out = blind.unblind("System A rambles. System B ends well. Systematic is not a letter.", key, labels)
    assert out == "TinyStories-33M (completion) rambles. Chittu story v0 (26M) (requests) ends well. Systematic is not a letter."
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_blind.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.blind'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/blind.py`:

```python
"""
The human read is blind: the reviewer sees lettered systems and a random sample, the key
sits in a separate file, and the card step unblinds only when the findings are filled in.
A script never writes a human judgement (the M1 card's rule).
"""
from __future__ import annotations

import json
import random
import re
import string
from pathlib import Path

from .io_utils import read_jsonl

FINDINGS_TEMPLATE = (
    "reviewer: \n"
    "date: \n"
    "sample_size: \n"
    "\n"
    "<!-- Read every item in every lettered file. Refer to systems as 'System A', 'System B' …\n"
    "     Rubric per item: coherent (one story, characters persist)? vocabulary a 4-year-old knows?\n"
    "     follows the request (requests only)? reaches an ending? anything that should never reach\n"
    "     a child even though both gates passed? Write what you read below this comment. -->\n"
)

_HEADER = ("reviewer", "date", "sample_size")


def make_blind(out_dir: Path, *, seed: int = 7, per_system: int = 10) -> Path:
    out_dir = Path(out_dir)
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    human = out_dir / "human-read"
    human.mkdir(exist_ok=True)
    rng = random.Random(seed)
    letters = iter(string.ascii_uppercase)
    key: dict[str, dict] = {}
    for probe in ("completion", "requests"):
        systems = sorted(s for s, m in meta["systems"].items() if probe in m["probes"])
        rng.shuffle(systems)
        for system in systems:
            letter = next(letters)
            key[letter] = {"system": system, "probe": probe}
            rows = [r for r in read_jsonl(out_dir / system / "generations.jsonl") if r["probe"] == probe]
            sample = rng.sample(rows, min(per_system, len(rows)))
            (human / f"{letter}.md").write_text(_render(letter, probe, sample), encoding="utf-8")
    (human / "key.json").write_text(json.dumps(key, indent=2) + "\n", encoding="utf-8")
    findings = human / "FINDINGS.md"
    if not findings.exists():
        findings.write_text(FINDINGS_TEMPLATE, encoding="utf-8")
    return human


def _render(letter: str, probe: str, sample: list[dict]) -> str:
    parts = [f"# System {letter} — {probe}\n", "Blind sample. Do not open key.json until FINDINGS.md is written.\n"]
    for i, r in enumerate(sample, 1):
        shown = r["adapted"] if r.get("adapted") else r["prompt"]
        parts.append(f"\n### Item {i}\n\n**Prompt**\n\n```text\n{shown}\n```\n\n**Output**\n\n```text\n{r['text']}\n```\n")
    return "".join(parts)


def read_findings(path: Path) -> dict | None:
    text = Path(path).read_text(encoding="utf-8")
    header: dict[str, str] = {}
    body_lines: list[str] = []
    for line in text.splitlines():
        m = re.fullmatch(r"(reviewer|date|sample_size):\s*(.*)", line)
        if m and m.group(1) not in header and not body_lines:
            header[m.group(1)] = m.group(2).strip()
        else:
            body_lines.append(line)
    body = re.sub(r"<!--.*?-->", "", "\n".join(body_lines), flags=re.S).strip()
    filled = [k for k in _HEADER if header.get(k)]
    if not filled and not body:
        return None
    if len(filled) != len(_HEADER) or not body:
        raise ValueError(f"{path}: findings are half-filled (have {filled}, body {'present' if body else 'empty'})")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", header["date"]):
        raise ValueError(f"{path}: date must be ISO, got {header['date']!r}")
    return {"reviewer": header["reviewer"], "date": header["date"], "sample_size": int(header["sample_size"]), "findings": body}


def unblind(text: str, key: dict, labels: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        k = key[m.group(1)]
        return f"{labels[k['system']]} ({k['probe']})"
    return re.sub(r"\bSystem ([A-Z])\b", repl, text)
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_blind.py
```

Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/compare/blind.py llm-kit/compare/tests/test_blind.py
git commit -m "compare: a blind human-read sample, its key, and the findings file

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `contamination` — no eval prompt inside the training corpus

**Files:**
- Create: `llm-kit/compare/compare/contamination.py`, `llm-kit/compare/tests/test_contamination.py`

**Interfaces:**
- Produces: `corpus_path() -> Path` (`chittu.common.data_dir() / "stories.kept.jsonl"`); `check(needles: list[str], corpus: Path, field="story") -> dict` = `{"status": "not run", "reason": str}` when the file is absent, else `{"status": "run", "records": n, "needles": len(needles), "hits": {needle: [record ids]}}`.

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_contamination.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_contamination.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.contamination'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/contamination.py`:

```python
"""Never train on eval prompts — and prove it, or say the proof did not run."""
from __future__ import annotations

import json
from pathlib import Path

from .paths import ensure_nanochat_on_path


def corpus_path() -> Path:
    ensure_nanochat_on_path()
    from chittu.common import data_dir
    return data_dir() / "stories.kept.jsonl"


def check(needles: list[str], corpus: Path, field: str = "story") -> dict:
    corpus = Path(corpus)
    if not corpus.exists():
        return {"status": "not run", "reason": f"{corpus} is absent on this machine"}
    hits: dict[str, list[str]] = {}
    n = 0
    with open(corpus, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            n += 1
            text = rec.get(field, "")
            for needle in needles:
                if needle in text:
                    hits.setdefault(needle, []).append(str(rec.get("id")))
    return {"status": "run", "records": n, "needles": len(needles), "hits": hits}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_contamination.py
```

Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/compare/contamination.py llm-kit/compare/tests/test_contamination.py
git commit -m "compare: the contamination check, which says 'not run' rather than 'clean'

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `card` — validate, build, render

**Files:**
- Create: `llm-kit/compare/compare/card.py`, `llm-kit/compare/tests/test_card.py`

**Interfaces:**
- Consumes: `REPO_ROOT`; `verdict_label` from `compare.hygiene`; meta (Task 4), folds (Task 6), findings/key (Task 7), contamination (Task 8).
- Produces: `CARD_ID = "story-vs-tinystories"`; `CAVEATS: list[str]`; `validate(card: dict) -> list[str]` (problems; empty means valid — mirrors the website's Zod rules); `build_card(meta, folds_by_system, *, date, commit, human=None, contamination=None) -> dict`; `render_md(card, meta, generations_by_system, verdicts_by_system, reports_by_system, contamination, human_text) -> str`; `card_paths(date) -> tuple[Path, Path]` (`comparisons/cards/<id>-<date>.json`, `.md`).

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_card.py`:

```python
import copy
import json

import pytest

from compare import card
from compare.paths import REPO_ROOT

FIXTURE = json.loads((REPO_ROOT / "comparisons" / "fixtures" / "example-card.json").read_text())


def test_the_shared_fixture_validates():
    assert card.validate(FIXTURE) == []


def _broken(mutate):
    c = copy.deepcopy(FIXTURE)
    mutate(c)
    return c


@pytest.mark.parametrize("mutate", [
    lambda c: c["metrics"][0].pop("denominator"),
    lambda c: c.__setitem__("caveats", []),
    lambda c: c["systems"][1].__setitem__("isChittu", True),
    lambda c: c["metrics"][0]["values"].pop("tinystories-1m"),                       # participating system missing
    lambda c: c["metrics"][0]["values"].__setitem__("tinystories-instruct-33m", 1.0),  # non-participant present
    lambda c: c["metrics"][0]["values"].__setitem__("tinystories-1m", None),          # null without a note
    lambda c: c["humanRead"].__setitem__("reviewer", "Someone"),                      # half-filled
    lambda c: c.__setitem__("imported", {"fromCommit": "abc"}),
    lambda c: c["producedBy"].__setitem__("repo", "Tulifo/other"),
    lambda c: c["producedBy"].__setitem__("commit", "abc"),
    lambda c: c["links"].__setitem__("card", "/elsewhere/x.md"),
    lambda c: c["links"]["external"][0].__setitem__("url", "http://insecure"),
    lambda c: c["systems"][0]["probes"].append("nonsense"),
    lambda c: c["metrics"][0].__setitem__("probe", "nonsense"),
])
def test_broken_variants_are_refused(mutate):
    assert card.validate(_broken(mutate)) != []


def test_null_with_a_note_is_allowed():
    c = _broken(lambda c: (c["metrics"][0]["values"].__setitem__("tinystories-1m", None),
                           c["metrics"][0].__setitem__("notes", {"tinystories-1m": "did not run"})))
    assert card.validate(c) == []


def _meta():
    return {
        "date": "2026-10-02",
        "decoding": {"temperature": 0.6, "top_k": 50, "seeds": [42, 43, 44], "completion_tokens": 200, "request_tokens": 400},
        "prompts": {"completion": {"count": 44, "source": "TinyStories 'Evaluation prompts.yaml'"},
                    "requests": {"count": 20, "source": "llm-kit/nanochat/chittu/story_requests.txt"}},
        "systems": {
            "chittu-story-v0-26m": {"label": "Chittu story v0 (26M)", "is_chittu": True, "source": "huggingface:Tulifo/chittu-story-v0-26m",
                                    "revision": "4f11284f8ebc19348ce2885bfea66eb13c8717cc", "params": 26345726,
                                    "probes": ["completion", "requests"], "notes": "two checkpoints", "counts": {"completion": 132, "requests": 60}},
            "tinystories-33m": {"label": "TinyStories-33M", "is_chittu": False, "source": "huggingface:roneneldan/TinyStories-33M",
                                "revision": "2ad0a164221b7c4d21cac7c46aec74f6f98dbfc8", "params": 68000000,
                                "probes": ["completion"], "notes": None, "counts": {"completion": 132}},
            "tinystories-instruct-33m": {"label": "TinyStories-Instruct-33M", "is_chittu": False,
                                         "source": "huggingface:roneneldan/TinyStories-Instruct-33M",
                                         "revision": "a16a5748e848e534c3efa91b4d96dd752db27e5f", "params": 68000000,
                                         "probes": ["requests"], "notes": "adapter", "counts": {"requests": 60}},
        },
        "versions": {"python": "3.10.21", "torch": "2.9.1", "transformers": "4.57.0"},
    }


def _folds():
    return {
        "chittu-story-v0-26m": {"completion": {"total": 132, "clean": 132, "ended": 118, "by_kind": {}, "clean_pct": 100.0, "ended_pct": 89.4},
                                "requests": {"total": 60, "clean": 60, "ended": 60, "by_kind": {}, "clean_pct": 100.0, "ended_pct": 100.0}},
        "tinystories-33m": {"completion": {"total": 132, "clean": 129, "ended": 110, "by_kind": {"L6": 3}, "clean_pct": 97.7, "ended_pct": 83.3}},
        "tinystories-instruct-33m": {"requests": {"total": 60, "clean": 57, "ended": 59, "by_kind": {"L1:unsafe": 3}, "clean_pct": 95.0, "ended_pct": 98.3}},
    }


def test_build_card_is_valid_and_carries_the_numbers():
    c = card.build_card(_meta(), _folds(), date="2026-10-02", commit="a" * 40)
    assert card.validate(c) == []
    assert c["id"] == "story-vs-tinystories" and c["kind"] == "story" and c["imported"] is None
    assert c["links"]["card"] == "/chittu/cards/story-vs-tinystories-2026-10-02.md"
    m = {x["key"]: x for x in c["metrics"]}
    assert m["clean_completion"]["denominator"] == 132
    assert m["clean_completion"]["values"] == {"chittu-story-v0-26m": 100.0, "tinystories-33m": 97.7}
    assert m["clean_completion"]["counts"] == {"chittu-story-v0-26m": 132, "tinystories-33m": 129}
    assert m["ended_completion"]["values"]["tinystories-33m"] == 83.3
    assert m["clean_requests"]["values"] == {"chittu-story-v0-26m": 100.0, "tinystories-instruct-33m": 95.0}
    assert c["humanRead"] == {"reviewer": None, "date": None, "sampleSize": None, "findings": None}
    assert c["method"]["judge"] is None
    assert "100.0%" in c["claim"] and "97.7%" in c["claim"]
    assert c["caveats"] == card.CAVEATS
    assert [s["id"] for s in c["systems"]][0] == "chittu-story-v0-26m"


def test_build_card_folds_a_filled_human_read_and_contamination():
    human = {"reviewer": "Arun Kumar", "date": "2026-10-03", "sample_size": 40, "findings": "Chittu story v0 (26M) (requests) ends well."}
    contamination = {"status": "run", "records": 2327256, "needles": 64, "hits": {}}
    c = card.build_card(_meta(), _folds(), date="2026-10-02", commit="a" * 40, human=human, contamination=contamination)
    assert card.validate(c) == []
    assert c["humanRead"]["reviewer"] == "Arun Kumar" and c["humanRead"]["sampleSize"] == 40
    assert c["controls"][0]["label"].startswith("Contamination") and c["controls"][0]["passed"] is True


def test_render_md_prints_every_generation_with_its_label():
    c = card.build_card(_meta(), _folds(), date="2026-10-02", commit="a" * 40)
    gens = {"chittu-story-v0-26m": [{"id": "chittu-story-v0-26m:completion:0:42", "probe": "completion", "index": 0, "seed": 42,
                                     "prompt": "Once upon", "adapted": None, "text": "a time.", "chars": 7, "ended": True}]}
    verdicts = {"chittu-story-v0-26m": [{"id": "chittu-story-v0-26m:completion:0:42", "keep": True}]}
    reports = {"chittu-story-v0-26m": {"total": 1, "kept": 1, "dropped": {}, "samples": {}}}
    md = card.render_md(c, _meta(), gens, verdicts, reports, None, None)
    assert "# The story model against TinyStories" in md
    assert "`[clean]`" in md and "a time." in md
    assert "## Human read" in md and "Reviewer:" in md
    assert "The card is the artefact" in md


def test_card_paths():
    j, m = card.card_paths("2026-10-02")
    assert j == REPO_ROOT / "comparisons" / "cards" / "story-vs-tinystories-2026-10-02.json"
    assert m.name == "story-vs-tinystories-2026-10-02.md"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_card.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.card'`.

- [ ] **Step 3: Write the implementation**

`llm-kit/compare/compare/card.py`:

```python
"""
The card is the artefact. build_card() turns measurements into the JSON the website
consumes; validate() holds it to the same rules as the website's Zod schema (spec §2.3), so
a card that would fail the site build fails here first; render_md() writes every generation
verbatim with its label.
"""
from __future__ import annotations

import re
from pathlib import Path

from .hygiene import verdict_label
from .paths import REPO_ROOT

CARD_ID = "story-vs-tinystories"
TITLE = "The story model against TinyStories"
RUNNER = "llm-kit/compare/story_compare.py"

CAVEATS = [
    "The rubric quality of these stories has not been judged by a model or, until the human read is filled, by a person. Hygiene says what the guards would refuse, not whether the story is good.",
    "No perplexity: no text exists that neither model family saw.",
    "Different corpora: the TinyStories models trained on the V1 mixed GPT-3.5/GPT-4 data; Chittu on GPT-4 rows swept by its own guards. Sizes differ across the ladder.",
    "The Instruct model received a translated prompt it was never trained on.",
    "chittu-story-v0-26m has never served a child and clears none of the gates that would let it.",
]

_SLUG = re.compile(r"^[a-z0-9-]+$")
_KEY = re.compile(r"^[a-z0-9_]+$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CARD_LINK = re.compile(r"^/chittu/cards/[a-z0-9-]+\.md$")


def card_paths(date: str) -> tuple[Path, Path]:
    d = REPO_ROOT / "comparisons" / "cards"
    return d / f"{CARD_ID}-{date}.json", d / f"{CARD_ID}-{date}.md"


# --- validation (mirror of the website's Zod schema) -------------------------------------

def validate(c: dict) -> list[str]:  # noqa: C901 - one flat rule list is clearer than a class hierarchy
    p: list[str] = []
    need = lambda cond, msg: None if cond else p.append(msg)  # noqa: E731
    need(c.get("schema") == "chittu-comparison-card/1", "schema")
    need(isinstance(c.get("id"), str) and _SLUG.match(c["id"]), "id slug")
    need(c.get("kind") in ("behaviour", "story", "guard"), "kind")
    need(isinstance(c.get("date"), str) and _DATE.match(c["date"]), "date ISO")
    for k in ("title", "claim"):
        need(isinstance(c.get(k), str) and c[k].strip(), k)
    pb = c.get("producedBy") or {}
    need(pb.get("repo") == "Tulifo/chittu", "producedBy.repo")
    need(isinstance(pb.get("commit"), str) and _SHA.match(pb["commit"]), "producedBy.commit 40-hex")
    need(isinstance(pb.get("runner"), str) and pb["runner"], "producedBy.runner")
    systems = c.get("systems") or []
    need(len(systems) >= 2, "at least two systems")
    ids = [s.get("id") for s in systems]
    need(len(set(ids)) == len(ids), "system ids unique")
    need(sum(1 for s in systems if s.get("isChittu") is True) == 1, "exactly one isChittu")
    prompts = c.get("prompts") or []
    need(len(prompts) >= 1, "at least one prompt set")
    prompt_ids = {q.get("id") for q in prompts}
    for q in prompts:
        need(isinstance(q.get("count"), int) and q["count"] > 0, f"prompt {q.get('id')} count")
        need(isinstance(q.get("seeds"), list) and q["seeds"], f"prompt {q.get('id')} seeds")
        for k in ("label", "source"):
            need(isinstance(q.get(k), str) and q[k], f"prompt {q.get('id')} {k}")
    for s in systems:
        need(isinstance(s.get("probes"), list) and s["probes"], f"system {s.get('id')} probes")
        for pr in s.get("probes") or []:
            need(pr in prompt_ids, f"system {s.get('id')} names unknown probe {pr}")
        for k in ("label", "source", "revision"):
            need(isinstance(s.get(k), str) and s[k], f"system {s.get('id')} {k}")
    method = c.get("method") or {}
    for k in ("decoding", "grader"):
        need(isinstance(method.get(k), str) and method[k], f"method.{k}")
    need("judge" in method and (method["judge"] is None or isinstance(method["judge"], dict)), "method.judge")
    metrics = c.get("metrics") or []
    need(len(metrics) >= 1, "at least one metric")
    for m in metrics:
        need(isinstance(m.get("key"), str) and _KEY.match(m["key"]), "metric key")
        need(m.get("probe") in prompt_ids, f"metric {m.get('key')} names unknown probe {m.get('probe')}")
        need(isinstance(m.get("label"), str) and m["label"], f"metric {m.get('key')} label")
        need(m.get("unit") in ("percent", "count"), f"metric {m.get('key')} unit")
        need(isinstance(m.get("higherIsBetter"), bool), f"metric {m.get('key')} higherIsBetter")
        need(isinstance(m.get("denominator"), int) and m["denominator"] > 0, f"metric {m.get('key')} denominator")
        expected = sorted(s["id"] for s in systems if m.get("probe") in (s.get("probes") or []))
        values = m.get("values") if isinstance(m.get("values"), dict) else {}
        need(sorted(values) == expected, f"metric {m.get('key')} values must cover exactly {expected}")
        for sid, v in values.items():
            need(v is None or isinstance(v, (int, float)), f"metric {m.get('key')} value for {sid}")
            if v is None:
                need(isinstance((m.get("notes") or {}).get(sid), str), f"metric {m.get('key')}: null for {sid} needs a note")
    need(isinstance(c.get("controls"), list), "controls list")
    hr = c.get("humanRead") or {}
    keys = ("reviewer", "date", "sampleSize", "findings")
    all_null = all(hr.get(k) is None for k in keys)
    all_set = all(hr.get(k) not in (None, "") for k in keys)
    need(all_null or all_set, "humanRead all null or all set")
    if all_set:
        need(_DATE.match(str(hr["date"])) is not None and isinstance(hr["sampleSize"], int), "humanRead date/sampleSize")
    caveats = c.get("caveats")
    need(isinstance(caveats, list) and caveats and all(isinstance(x, str) and x.strip() for x in caveats), "caveats non-empty")
    links = c.get("links") or {}
    need(isinstance(links.get("card"), str) and _CARD_LINK.match(links["card"]), "links.card path")
    ext = links.get("external")
    need(isinstance(ext, list), "links.external list")
    for e in ext or []:
        need(isinstance(e.get("url"), str) and e["url"].startswith("https://"), "external url https")
        need(isinstance(e.get("label"), str) and e["label"], "external label")
    imp = c.get("imported", "missing")
    need(imp is None or (isinstance(imp, dict) and _SHA.match(str(imp.get("fromCommit", ""))) and _DATE.match(str(imp.get("at", "")))),
         "imported null or {fromCommit, at}")
    return p


# --- building -----------------------------------------------------------------------------

def _systems(meta: dict) -> list[dict]:
    items = sorted(meta["systems"].items(), key=lambda kv: (not kv[1]["is_chittu"], kv[0]))
    out = []
    for sid, m in items:
        s = {"id": sid, "label": m["label"], "isChittu": m["is_chittu"], "source": m["source"],
             "revision": m["revision"], "params": m["params"], "probes": list(m["probes"])}
        if m.get("notes"):
            s["notes"] = m["notes"]
        out.append(s)
    return out


def _metric(key, probe, label, folds, participants, denominator, field, pct_field):
    return {
        "key": key, "probe": probe, "label": label, "unit": "percent", "higherIsBetter": True,
        "denominator": denominator,
        "values": {sid: folds[sid][probe][pct_field] for sid in participants},
        "counts": {sid: folds[sid][probe][field] for sid in participants},
    }


def build_card(meta: dict, folds: dict, *, date: str, commit: str, human: dict | None = None,
               contamination: dict | None = None) -> dict:
    systems = _systems(meta)
    dec = meta["decoding"]
    seeds = list(dec["seeds"])
    metrics = []
    for probe, label_suffix in (("completion", "completions"), ("requests", "requests")):
        participants = [s["id"] for s in systems if probe in s["probes"]]
        if not participants:
            continue
        denominator = meta["prompts"][probe]["count"] * len(seeds)
        metrics.append(_metric(f"clean_{probe}", probe, f"Would pass Chittu's guards ({label_suffix})", folds, participants, denominator, "clean", "clean_pct"))
        metrics.append(_metric(f"ended_{probe}", probe, f"Reached an ending within the budget ({label_suffix})", folds, participants, denominator, "ended", "ended_pct"))
    chittu_id = next(s["id"] for s in systems if s["isChittu"])
    others = [v for k, v in metrics[0]["values"].items() if k != chittu_id]
    claim = (
        f"On the TinyStories paper's own prompts, {metrics[0]['values'][chittu_id]}% of the 26M Chittu story model's completions "
        f"would pass Chittu's child-safety guards, against {min(others)}–{max(others)}% for the TinyStories models measured beside it."
        if others else f"On the TinyStories paper's own prompts, {metrics[0]['values'][chittu_id]}% of the Chittu story model's completions would pass Chittu's child-safety guards."
    )
    controls = []
    if contamination is not None:
        if contamination["status"] == "run":
            controls.append({"label": "Contamination: no evaluation prompt or request appears verbatim in Chittu's training corpus",
                             "expected": "0 hits", "observed": f"{sum(len(v) for v in contamination['hits'].values())} hits over {contamination['records']} stories and {contamination['needles']} needles",
                             "passed": not contamination["hits"]})
        else:
            controls.append({"label": "Contamination check", "expected": "run", "observed": f"not run: {contamination['reason']}", "passed": False})
    human_read = ({"reviewer": human["reviewer"], "date": human["date"], "sampleSize": human["sample_size"], "findings": human["findings"]}
                  if human else {"reviewer": None, "date": None, "sampleSize": None, "findings": None})
    _, md_path = card_paths(date)
    return {
        "schema": "chittu-comparison-card/1",
        "id": CARD_ID, "kind": "story", "date": date, "title": TITLE, "claim": claim,
        "producedBy": {"repo": "Tulifo/chittu", "commit": commit, "runner": RUNNER},
        "systems": systems,
        "prompts": [
            {"id": "completion", "label": "the paper's 44 completion prompts", "source": meta["prompts"]["completion"]["source"],
             "count": meta["prompts"]["completion"]["count"], "seeds": seeds},
            {"id": "requests", "label": "20 requests written as a child types them", "source": meta["prompts"]["requests"]["source"],
             "count": meta["prompts"]["requests"]["count"], "seeds": seeds},
        ],
        "method": {
            "decoding": f"temperature {dec['temperature']}, top-k {dec['top_k']}; {dec['completion_tokens']} new tokens for completions, {dec['request_tokens']} for requests, in each model's own tokenizer; seeds {seeds}",
            "grader": "Chittu L1 scan() + L6 passesOutputFilter(), via pnpm story:sweep --fields text --verdicts",
            "judge": None,
        },
        "metrics": metrics,
        "controls": controls,
        "humanRead": human_read,
        "caveats": list(CAVEATS),
        "links": {
            "card": f"/chittu/cards/{md_path.name}",
            "external": [
                {"label": s["label"] + " on Hugging Face", "url": "https://huggingface.co/" + s["source"].split(":", 1)[1]} for s in systems
            ],
        },
        "imported": None,
    }


# --- the human card ----------------------------------------------------------------------

def render_md(card: dict, meta: dict, generations: dict, verdicts: dict, reports: dict,
              contamination: dict | None, human_text: str | None) -> str:
    L = [f"# {card['title']} — {card['date']}\n", f"{card['claim']}\n",
         "**The card is the artefact; the summary line is a convenience.** Every generation is below, verbatim, with the guards' verdict.\n",
         "## Systems\n", "| id | label | source | revision | parameters | probes |", "|---|---|---|---|---|---|"]
    for s in card["systems"]:
        L.append(f"| `{s['id']}` | {s['label']} | `{s['source']}` | `{s['revision']}` | {s['params']:,} | {', '.join(s['probes'])} |")
    L += ["\n## Method\n", f"- Decoding: {card['method']['decoding']}", f"- Grader: {card['method']['grader']}",
          f"- Judge: {'none' if card['method']['judge'] is None else card['method']['judge']}",
          f"- Versions: {meta.get('versions')}", ""]
    L += ["## Metrics\n", "| metric | probe | denominator | " + " | ".join(s["id"] for s in card["systems"]) + " |",
          "|---|---|---|" + "---|" * len(card["systems"])]
    for m in card["metrics"]:
        cells = [f"{m['values'][s['id']]}% ({m['counts'][s['id']]})" if s["id"] in m["values"] else "—" for s in card["systems"]]
        L.append(f"| {m['label']} | {m['probe']} | {m['denominator']} | " + " | ".join(cells) + " |")
    L.append("")
    if contamination is not None:
        L += ["## Contamination check\n", f"```json\n{contamination}\n```\n"]
    L += ["## What this does not show\n"] + [f"- {c}" for c in card["caveats"]] + [""]
    L += ["## Human read\n"]
    if human_text:
        hr = card["humanRead"]
        L += [f"- Reviewer: {hr['reviewer']}", f"- Date: {hr['date']}", f"- Sample size: {hr['sampleSize']}", "", human_text, ""]
    else:
        L += ["_Left blank for a person. Blind sample and rubric: `human-read/` beside the raw generations. A script must not fill this in._",
              "", "- Reviewer:", "- Date:", "- Sample size:", "- Findings:", ""]
    L += ["## Generations\n"]
    for s in card["systems"]:
        sid = s["id"]
        by_id = {v["id"]: v for v in verdicts.get(sid, [])}
        rep = reports.get(sid, {})
        L.append(f"### {s['label']} (`{sid}`) — sweep: {rep.get('kept')} kept of {rep.get('total')}, dropped {rep.get('dropped')}\n")
        for g in generations.get(sid, []):
            label = verdict_label(by_id[g["id"]])
            L.append(f"#### {g['probe']} {g['index']} · seed {g['seed']} · `[{label}]` · {g['chars']} chars · {'ended' if g['ended'] else 'cut at budget'}\n")
            L.append(f"**Prompt**\n\n```text\n{g['prompt']}\n```\n")
            if g.get("adapted"):
                L.append(f"**As the model saw it**\n\n```text\n{g['adapted']}\n```\n")
            L.append(f"**Output**\n\n```text\n{g['text']}\n```\n")
    return "\n".join(L)
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_card.py
```

Expected: `20 passed`.

- [ ] **Step 5: Mutation-test the validator and record the counts**

Temporarily break each rule and confirm tests fail, then restore:

1. In `validate`, delete the `caveats non-empty` line → run `tests/test_card.py` → expect at least 1 failure (`caveats: []` variant).
2. Delete the `exactly one isChittu` line → at least 1 failure.
3. Delete the `values must cover exactly` line → at least 2 failures (missing participant, non-participant).
4. Delete the `null … needs a note` line → at least 1 failure.

Restore the file, run `uv run --frozen python -m pytest -q`, expect all green. Note the four counts in the commit message.

- [ ] **Step 6: Commit**

```bash
git add llm-kit/compare/compare/card.py llm-kit/compare/tests/test_card.py
git commit -m "compare: the card — validated to the website's rules, every generation verbatim

Mutation checks: caveats rule -1 fails N, one-isChittu -1 fails N, values-cover -1 fails N, null-needs-note -1 fails N.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The CLI `story_compare.py`

**Files:**
- Create: `llm-kit/compare/story_compare.py`, `llm-kit/compare/tests/test_cli.py`

**Interfaces:**
- Consumes: everything above.
- Produces: sub-commands `generate --out DIR [--systems a,b] [--limit N] [--seeds 42,43,44]`, `sweep --out DIR`, `blind --out DIR [--seed 7] [--per-system 10]`, `card --out DIR [--date YYYY-MM-DD] [--human-read FILE] [--skip-contamination] [--commit SHA]`; `main(argv) -> int`.

- [ ] **Step 1: Write the failing tests**

`llm-kit/compare/tests/test_cli.py`:

```python
import json

import pytest

import story_compare
from compare import generate
from compare.io_utils import write_jsonl


def test_help_for_every_subcommand(capsys):
    for sub in ("generate", "sweep", "blind", "card"):
        with pytest.raises(SystemExit) as e:
            story_compare.main([sub, "--help"])
        assert e.value.code == 0
        assert "--out" in capsys.readouterr().out


def test_card_command_refuses_when_the_instrument_disagrees(tmp_path, fake_systems, monkeypatch):
    generate.run_generate(fake_systems, ["Once upon", "Lily found"], ["tell me a story about rain"], tmp_path, seeds=(42,))
    # Fake sweep artefacts for every system, but one report claims a different total.
    for sid in ("chittu-story-v0-26m", "tinystories-33m", "tinystories-instruct-33m"):
        d = tmp_path / sid
        gens = [json.loads(l) for l in (d / "generations.jsonl").read_text().splitlines()]
        write_jsonl(d / "verdicts.jsonl", [{"id": g["id"], "keep": True} for g in gens])
        total = len(gens) if sid != "tinystories-33m" else len(gens) + 1
        (d / "sweep.json").write_text(json.dumps({"total": total, "kept": total, "dropped": {}, "samples": {}}))
    with pytest.raises(SystemExit) as e:
        story_compare.main(["card", "--out", str(tmp_path), "--skip-contamination", "--commit", "b" * 40])
    assert "instrument check failed" in str(e.value)


def test_card_command_writes_both_files(tmp_path, fake_systems, monkeypatch):
    generate.run_generate(fake_systems, ["Once upon", "Lily found"], ["tell me a story about rain"], tmp_path, seeds=(42,))
    for sid in ("chittu-story-v0-26m", "tinystories-33m", "tinystories-instruct-33m"):
        d = tmp_path / sid
        gens = [json.loads(l) for l in (d / "generations.jsonl").read_text().splitlines()]
        write_jsonl(d / "verdicts.jsonl", [{"id": g["id"], "keep": True} for g in gens])
        (d / "sweep.json").write_text(json.dumps({"total": len(gens), "kept": len(gens), "dropped": {}, "samples": {}}))
    cards_dir = tmp_path / "cards"
    monkeypatch.setattr(story_compare.card, "card_paths", lambda date: (cards_dir / f"story-vs-tinystories-{date}.json", cards_dir / f"story-vs-tinystories-{date}.md"))
    assert story_compare.main(["card", "--out", str(tmp_path), "--skip-contamination", "--commit", "b" * 40, "--date", "2026-10-02"]) == 0
    c = json.loads((cards_dir / "story-vs-tinystories-2026-10-02.json").read_text())
    assert c["metrics"][0]["denominator"] == 2 and c["humanRead"]["reviewer"] is None
    assert (cards_dir / "story-vs-tinystories-2026-10-02.md").read_text().count("#### ") == 2 + 2 + 1 + 1
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_cli.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'story_compare'`.

- [ ] **Step 3: Write the CLI**

`llm-kit/compare/story_compare.py`:

```python
#!/usr/bin/env python
"""
The story comparison, end to end. argv only; logic lives in compare/.

  generate  -> <out>/<system>/generations.jsonl + <out>/meta.json
  sweep     -> pnpm story:sweep per system (kept.jsonl, sweep.json, sweep.md, verdicts.jsonl)
  blind     -> <out>/human-read/{A..}.md, key.json, FINDINGS.md
  card      -> comparisons/cards/story-vs-tinystories-<date>.{json,md}   (refuses on the instrument check)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from compare import blind, card, contamination, generate, hygiene, prompts, systems
from compare.io_utils import read_jsonl
from compare.paths import REPO_ROOT


def _git_head() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, check=True, capture_output=True, text=True).stdout.strip()


def cmd_generate(a) -> int:
    specs = [systems.by_id(s) for s in a.systems.split(",")] if a.systems else list(systems.REGISTRY)
    loaded = []
    for spec in specs:
        print(f"loading {spec.id} @ {spec.revision[:7]}", file=sys.stderr)
        loaded.append(systems.load_system(spec))
    seeds = tuple(int(s) for s in a.seeds.split(","))
    meta = generate.run_generate(loaded, prompts.load_completion_prompts(), prompts.load_requests(), Path(a.out), seeds=seeds, limit=a.limit)
    for sid, m in meta["systems"].items():
        print(f"{sid}: {m['counts']}")
    return 0


def cmd_sweep(a) -> int:
    out = Path(a.out)
    meta = json.loads((out / "meta.json").read_text())
    for sid in meta["systems"]:
        rep = hygiene.run_sweep(out / sid)
        print(f"{sid}: {rep['kept']} kept of {rep['total']}")
    return 0


def cmd_blind(a) -> int:
    human = blind.make_blind(Path(a.out), seed=a.seed, per_system=a.per_system)
    print(f"blind sample written to {human}; read every lettered file, fill FINDINGS.md, then run `card --human-read {human / 'FINDINGS.md'}`")
    return 0


def cmd_card(a) -> int:
    out = Path(a.out)
    meta = json.loads((out / "meta.json").read_text())
    gens, verds, reps, folds = {}, {}, {}, {}
    for sid in meta["systems"]:
        d = out / sid
        gens[sid] = read_jsonl(d / "generations.jsonl")
        verds[sid] = read_jsonl(d / "verdicts.jsonl")
        reps[sid] = json.loads((d / "sweep.json").read_text())
        hygiene.check_instrument(reps[sid], gens[sid], verds[sid])
        folds[sid] = hygiene.fold(gens[sid], verds[sid])
    contam = None
    if not a.skip_contamination:
        needles = prompts.load_completion_prompts() + prompts.load_requests()
        contam = contamination.check(needles, contamination.corpus_path())
    human = human_text = None
    if a.human_read:
        human = blind.read_findings(Path(a.human_read))
        if human is None:
            raise SystemExit(f"{a.human_read} is blank; the card keeps humanRead null until a person fills it")
        key = json.loads((Path(a.human_read).parent / "key.json").read_text())
        labels = {sid: m["label"] for sid, m in meta["systems"].items()}
        human = {**human, "findings": blind.unblind(human["findings"], key, labels)}
        human_text = human["findings"]
    date = a.date or meta["date"]
    c = card.build_card(meta, folds, date=date, commit=a.commit or _git_head(), human=human, contamination=contam)
    problems = card.validate(c)
    if problems:
        raise SystemExit("card invalid: " + "; ".join(problems))
    json_path, md_path = card.card_paths(date)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(c, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(card.render_md(c, meta, gens, verds, reps, contam, human_text), encoding="utf-8")
    print(f"card: {json_path}\n      {md_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="the story comparison, end to end")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate"); g.add_argument("--out", required=True); g.add_argument("--systems", default=None)
    g.add_argument("--limit", type=int, default=None); g.add_argument("--seeds", default=",".join(str(s) for s in systems.DECODING["seeds"]))
    g.set_defaults(fn=cmd_generate)
    s = sub.add_parser("sweep"); s.add_argument("--out", required=True); s.set_defaults(fn=cmd_sweep)
    b = sub.add_parser("blind"); b.add_argument("--out", required=True); b.add_argument("--seed", type=int, default=7)
    b.add_argument("--per-system", type=int, default=10); b.set_defaults(fn=cmd_blind)
    c = sub.add_parser("card"); c.add_argument("--out", required=True); c.add_argument("--date", default=None)
    c.add_argument("--human-read", default=None); c.add_argument("--skip-contamination", action="store_true")
    c.add_argument("--commit", default=None); c.set_defaults(fn=cmd_card)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run all tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q
```

Expected: everything green, `1 skipped` (the slow real-model test).

- [ ] **Step 5: Commit**

```bash
git add llm-kit/compare/story_compare.py llm-kit/compare/tests/test_cli.py
git commit -m "compare: the CLI — generate, sweep, blind, card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The `pnpm verify` lane, pinned by a test

**Files:**
- Modify: `scripts/verify.sh` (one line after the `story kit` lane)
- Create: `apps/api/src/verify-compare-lane.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/src/verify-compare-lane.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = readFileSync(join(HERE, '..', '..', '..', 'scripts', 'verify.sh'), 'utf8');

describe('the compare-kit verify lane', () => {
  it('exists and runs the kit\'s tests under uv', () => {
    expect(VERIFY).toContain('step "compare kit"');
    expect(VERIFY).toMatch(/cd llm-kit\/compare && uv run --frozen python -m pytest -q/);
  });
  it('is gated on the env existing and says SKIPPED otherwise, like the story kit lane', () => {
    expect(VERIFY).toContain('if [ -x llm-kit/compare/.venv/bin/python ]');
    expect(VERIFY).toMatch(/SKIPPED: compare kit env not set up \(cd llm-kit\/compare && uv sync --frozen --group dev\) — its tests did not run/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run --project server apps/api/src/verify-compare-lane.test.ts
```

Expected: FAIL — `expected … to contain 'step "compare kit"'`.

- [ ] **Step 3: Add the lane**

In `scripts/verify.sh`, directly after the `step "story kit"` line, add:

```bash
step "compare kit"        bash -c 'if [ -x llm-kit/compare/.venv/bin/python ]; then cd llm-kit/compare && uv run --frozen python -m pytest -q; else echo "   SKIPPED: compare kit env not set up (cd llm-kit/compare && uv sync --frozen --group dev) — its tests did not run"; fi'
```

- [ ] **Step 4: Run the test and the lane**

```bash
pnpm vitest run --project server apps/api/src/verify-compare-lane.test.ts
bash -c 'cd llm-kit/compare && uv run --frozen python -m pytest -q'
```

Expected: the test passes; the kit's tests are green.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify.sh apps/api/src/verify-compare-lane.test.ts
git commit -m "verify: the compare-kit lane, gated on its env like the story kit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Run the story comparison for real and commit the card

**Files:**
- Create: `comparisons/cards/story-vs-tinystories-<date>.json`, `comparisons/cards/story-vs-tinystories-<date>.md`

- [ ] **Step 1: Prove the real loaders on the smallest models**

```bash
cd llm-kit/compare && COMPARE_REAL=1 uv run --frozen python -m pytest -q tests/test_systems.py -m slow
```

Expected: `1 passed`. First run downloads `TinyStories-1M` (a few MB) and the GPT-Neo tokenizer; the Chittu snapshot is already cached at revision `4f11284`.

- [ ] **Step 2: Smoke the whole pipeline at toy size**

```bash
cd llm-kit/compare && OUT=~/.cache/chittu-compare/smoke && rm -rf "$OUT" && \
uv run --frozen python story_compare.py generate --out "$OUT" --systems chittu-story-v0-26m,tinystories-1m,tinystories-instruct-33m --limit 2 --seeds 42 && \
uv run --frozen python story_compare.py sweep --out "$OUT" && \
uv run --frozen python story_compare.py blind --out "$OUT" && \
uv run --frozen python story_compare.py card --out "$OUT" --skip-contamination --date 1999-01-01
```

Expected: three systems generate (Chittu 2+2, 1M 2, Instruct 2), the sweep prints `kept of total` per system, blind writes lettered files, and `card` writes `comparisons/cards/story-vs-tinystories-1999-01-01.{json,md}`. Read the markdown: every generation present with a label. Then **delete the smoke card**: `rm comparisons/cards/story-vs-tinystories-1999-01-01.*` — a smoke card is not an artefact.

- [ ] **Step 3: The real run**

```bash
cd llm-kit/compare && DATE=$(date +%F) && OUT=~/.cache/chittu-compare/story-vs-tinystories-$DATE && \
uv run --frozen python story_compare.py generate --out "$OUT" && \
uv run --frozen python story_compare.py sweep --out "$OUT" && \
uv run --frozen python story_compare.py blind --out "$OUT" && \
uv run --frozen python story_compare.py card --out "$OUT" --date "$DATE"
```

Expected: 132 completions for each of five systems and 60 requests for two; six sweeps; the contamination check runs over 2,327,256 stories (a minute or two) and reports its hits (expected 0 — if not 0, that is a finding: record it, do not edit the prompts); the card is written with `humanRead` all null. Wall clock: minutes for generation on this Mac (the largest model is 33M parameters), the contamination scan dominating.

- [ ] **Step 4: Read the card before committing it**

Open `comparisons/cards/story-vs-tinystories-<date>.md`. Check: the systems table shows the pinned revisions and measured parameter counts; the metrics table has denominators 132 and 60; the Instruct generations show the adapted prompt; labels are present on every generation; the human read is blank. Confirm the JSON validates against the website's fixture rules: `uv run --frozen python -c "import json,sys; from compare import card; print(card.validate(json.load(open(sys.argv[1]))))" ../../comparisons/cards/story-vs-tinystories-<date>.json` → `[]`.

- [ ] **Step 5: Commit the card**

```bash
git add comparisons/cards/story-vs-tinystories-*.json comparisons/cards/story-vs-tinystories-*.md
git commit -m "comparisons: story-vs-tinystories card, <date> — hygiene and ending rate, human read blank

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: The landscape card

**Files:**
- Create: `comparisons/cards/landscape-<date>.json`, `comparisons/cards/landscape-<date>.md`, `llm-kit/compare/compare/landscape.py`, `llm-kit/compare/tests/test_landscape.py`

**Interfaces:**
- Produces: `validate_landscape(card: dict) -> list[str]` (the landscape half of the website's Zod rules: base fields as in `card.validate`, `kind == "landscape"`, `columns` non-empty with `key`/`label`, `rows` ≥ 2 each naming a system and carrying every column and no others, every cell `{value, source: https, asOf: ISO}`, exactly one `isChittu` system, `imported: null`, caveats non-empty).

- [ ] **Step 1: Write the failing test**

`llm-kit/compare/tests/test_landscape.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_landscape.py
```

Expected: FAIL with `ModuleNotFoundError: No module named 'compare.landscape'`.

- [ ] **Step 3: Write the validator**

`llm-kit/compare/compare/landscape.py`:

```python
"""The landscape card is authored by hand; this holds it to the website's rules before it is committed."""
from __future__ import annotations

import re

_SLUG = re.compile(r"^[a-z0-9-]+$")
_KEY = re.compile(r"^[a-z0-9_]+$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CARD_LINK = re.compile(r"^/chittu/cards/[a-z0-9-]+\.md$")


def validate_landscape(c: dict) -> list[str]:  # noqa: C901
    p: list[str] = []
    need = lambda cond, msg: None if cond else p.append(msg)  # noqa: E731
    need(c.get("schema") == "chittu-comparison-card/1", "schema")
    need(c.get("kind") == "landscape", "kind landscape")
    need(isinstance(c.get("id"), str) and _SLUG.match(c["id"]), "id slug")
    need(isinstance(c.get("date"), str) and _DATE.match(c["date"]), "date ISO")
    for k in ("title", "claim"):
        need(isinstance(c.get(k), str) and c[k].strip(), k)
    pb = c.get("producedBy") or {}
    need(pb.get("repo") == "Tulifo/chittu" and isinstance(pb.get("commit"), str) and _SHA.match(pb["commit"]) and pb.get("runner"), "producedBy")
    systems = c.get("systems") or []
    ids = [s.get("id") for s in systems]
    need(len(systems) >= 2 and len(set(ids)) == len(ids), "systems ≥2, unique")
    need(sum(1 for s in systems if s.get("isChittu") is True) == 1, "exactly one isChittu")
    for s in systems:
        for k in ("label", "source", "revision"):
            need(isinstance(s.get(k), str) and s[k], f"system {s.get('id')} {k}")
        need(isinstance(s.get("probes"), list) and s["probes"], f"system {s.get('id')} probes")
    columns = c.get("columns") or []
    need(len(columns) >= 1, "columns non-empty")
    keys = sorted(col.get("key") for col in columns)
    for col in columns:
        need(isinstance(col.get("key"), str) and _KEY.match(col["key"]) and isinstance(col.get("label"), str) and col["label"], "column key/label")
    rows = c.get("rows") or []
    need(len(rows) >= 2, "rows ≥2")
    for r in rows:
        need(r.get("system") in ids, f"row {r.get('system')} is not a system")
        cells = r.get("cells") if isinstance(r.get("cells"), dict) else {}
        need(sorted(cells) == keys, f"row {r.get('system')} must have every column and no others")
        for k, cell in cells.items():
            need(isinstance(cell, dict) and isinstance(cell.get("value"), str) and cell["value"].strip(), f"row {r.get('system')} {k} value")
            need(isinstance(cell.get("source"), str) and cell["source"].startswith("https://"), f"row {r.get('system')} {k} source https")
            need(isinstance(cell.get("asOf"), str) and _DATE.match(cell["asOf"]), f"row {r.get('system')} {k} asOf")
    caveats = c.get("caveats")
    need(isinstance(caveats, list) and caveats and all(isinstance(x, str) and x.strip() for x in caveats), "caveats non-empty")
    links = c.get("links") or {}
    need(isinstance(links.get("card"), str) and _CARD_LINK.match(links["card"]), "links.card")
    need(isinstance(links.get("external"), list) and all(isinstance(e.get("url"), str) and e["url"].startswith("https://") for e in links["external"]), "links.external")
    need(c.get("imported", "missing") is None, "imported null")
    return p
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd llm-kit/compare && uv run --frozen python -m pytest -q tests/test_landscape.py
```

Expected: `9 passed`.

- [ ] **Step 5: Author the card**

Research first, one vendor at a time, with WebSearch and WebFetch: HeyOtto, PinwheelGPT, LittleLit, Khanmigo, HolaNolis, OpenAI's parental controls for ChatGPT. For each, find the vendor's own page that states: where safety lives (their words), open weights (yes/no), what happens on a crisis message, safety beyond English, consent before use, what a parent sees of the child's words, engagement mechanics, stated age range. Record the URL and today's date on every cell. **If a page does not say, the value is exactly `not stated`** with the URL of the page you checked. Never infer from a third party's description, and never assign a number.

Chittu's row: values from spec §5's table; sources are public artefacts only — `https://tulifo.com/pinmbo` for the product claims (consent, what a parent sees, engagement, crisis), `https://huggingface.co/Tulifo` for open weights, `https://tulifo.com/chittu/cards/story-vs-tinystories-<date>.md` where a card backs a cell. Every Chittu cell is Tulifo's claim cited like everyone else's.

Write `comparisons/cards/landscape-<date>.json` in the shape of `comparisons/fixtures/example-landscape.json` (seven systems, eight columns from spec §5: `safety_layer`, `open_weights`, `crisis`, `languages`, `consent`, `child_data`, `engagement`, `age`; `probes: ["landscape"]` on every system; `fixture` absent; `producedBy.commit` = `git rev-parse HEAD`; `producedBy.runner` = `hand-authored; every cell re-verified against its source on the asOf date`; `claim` = *Where Chittu sits among the products that occupy the same layer: what each says about itself, cited to its own page.*; caveats = the two from the fixture plus *Chittu's crisis, language and consent claims are backed by the behaviour card once it lands; until then they are the product's public statements.*; `links.card` = `/chittu/cards/landscape-<date>.md`; `links.external` = one entry per vendor page cited). Write `comparisons/cards/landscape-<date>.md`: the table rendered as Markdown with a footnote per cell giving the source and date, then the caveats.

Validate:

```bash
cd llm-kit/compare && uv run --frozen python -c "import json,sys; from compare import landscape; print(landscape.validate_landscape(json.load(open(sys.argv[1]))))" ../../comparisons/cards/landscape-<date>.json
```

Expected: `[]`.

- [ ] **Step 6: Commit**

```bash
git add llm-kit/compare/compare/landscape.py llm-kit/compare/tests/test_landscape.py comparisons/cards/landscape-*.json comparisons/cards/landscape-*.md
git commit -m "comparisons: the landscape card — seven products, eight sourced columns, no assigned numbers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Verify the two `/chittu` load snippets and record it

The website prompt (`docs/superpowers/plans/2026-09-29-tulifo-website-drop1-prompt.md`) shows two snippets and promises the chittu side runs them.

- [ ] **Step 1: The story snippet (already run on 2026-09-29, re-run to record)**

```bash
cd llm-kit/compare && uv run --frozen python - <<'EOF'
import sys
sys.path.insert(0, "../nanochat")
from huggingface_hub import snapshot_download
repo_dir = snapshot_download("Tulifo/chittu-story-v0-26m")
sys.path.insert(0, repo_dir)
from load import load, story
model, tok = load(repo_dir)
print(story(model, tok, "tell me a story about a brave little sparrow")[:200])
EOF
```

Expected: a story beginning "Once upon a time…" is printed.

- [ ] **Step 2: The guard snippet, without the 8 GB download**

```bash
cd llm-kit/compare && uv run --frozen python - <<'EOF'
import torch
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
repo = "Tulifo/chittu-guard-v0-4b"
tok = AutoTokenizer.from_pretrained(repo)
cfg = AutoConfig.from_pretrained(repo)
with torch.device("meta"):
    model = AutoModelForCausalLM.from_config(cfg)
print(type(model).__name__, cfg.architectures, tok("hello").input_ids[:5])
EOF
```

Expected: `Qwen3ForCausalLM ['Qwen3ForCausalLM'] [...]` — the tokenizer and architecture resolve through transformers, which is what the snippet relies on; the weights (8 GB) are not downloaded here.

- [ ] **Step 3: Record the result in the prompt file and commit**

Append to `docs/superpowers/plans/2026-09-29-tulifo-website-drop1-prompt.md`, under a new heading `## Snippet verification (chittu side)`: the date, "story snippet: ran end to end on both checkpoints, 26,345,726 parameters", "guard snippet: tokenizer and `Qwen3ForCausalLM` config resolve via transformers; weights not downloaded (8 GB)", and any change the snippet needs (expected: none).

```bash
git add docs/superpowers/plans/2026-09-29-tulifo-website-drop1-prompt.md
git commit -m "docs: record the /chittu snippet verification for the website session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: `pnpm verify`, then hand over

- [ ] **Step 1: The whole gate**

```bash
pnpm verify
```

Expected: every lane green, including `compare kit`, `story kit`, the container lane. If Docker is not running, start it; do not pass `--no-container` for the final run.

- [ ] **Step 2: Rebase and push the branch, open the PR**

```bash
git fetch origin && git rebase origin/main && pnpm verify && git push -u origin arun/chittu-llm-comparison-1d7ee4
gh pr create --title "comparisons: the cards behind tulifo.com/chittu/compare (drop 1)" --body-file - <<'EOF'
Drop 1 of the comparison page (design: docs/superpowers/specs/2026-09-29-chittu-comparison-page-design.md).

- `llm-kit/compare/`: the story runner (its own uv project; nothing upstream patched). Six systems loaded from Hugging Face at pinned revisions, identical decoding, hygiene through the real sweep with an instrument check, a blind human-read sample, a card validated to the website's rules.
- `story-sweep --verdicts`: one verdict per record, so the card labels every generation.
- `comparisons/cards/story-vs-tinystories-<date>`: the measured card, human read blank.
- `comparisons/cards/landscape-<date>`: seven products, eight sourced columns, no number we assigned.
- `pnpm verify` gains the `compare kit` lane.

Not in this PR: the judge pass (deferred by the owner), drops 2 and 3. The website half is a separate PR in tulifo-website; import with `npm run import:cards -- <this checkout>`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 3: Hand the cards to the website session**

Tell Arun: the cards are in `comparisons/cards/`; run the website's `npm run import:cards -- <path to this checkout>` to bring them (and the fixtures) across, and the blind human-read sample is at `~/.cache/chittu-compare/story-vs-tinystories-<date>/human-read/` waiting for a reader. When FINDINGS.md is filled, re-run `card --human-read …` for a new dated card and re-import.

---

## Self-review

**Spec coverage.** §2.2 directories → Tasks 1, 12, 13. §2.3 schema rules → Task 9 `validate` and Task 13 `validate_landscape`, both tested against the shared fixtures. §2.5 verbatim-with-label publication → Task 9 `render_md`. §5 landscape → Task 13. §6.1 systems and pinned revisions → Task 2. §6.2 probes and decoding → Tasks 2, 4. §6.3 adapter → Task 3. §6.4 hygiene, instrument check, ending rate, human read, contamination → Tasks 6, 7, 8, 9. §6.5 judge → deferred, `method.judge: null`. §6.6 runner, tests, mutation checks, verify lane → Tasks 1–11. §9 `pnpm verify` → Task 15. HF mirror (§2.4) is a hand step after the website PR and is not in this plan, deliberately.

**Placeholders.** `<date>` is the run date and is filled at execution; `N` in Task 9's commit message is filled from the measured mutation counts. No other placeholders.

**Type consistency.** `Generation(text, ended)` everywhere; `SystemSpec.probes` is a tuple in code and a list in meta/card JSON (converted in `run_generate` and `_systems`); `fold()` returns per-probe dicts with `clean_pct`/`ended_pct`, which `_metric` reads by those names; `read_findings` returns `sample_size` (snake) and `build_card` writes `sampleSize` (camel), as the card schema requires; `hygiene.verdict_label` is the one place a verdict becomes a label, used by `render_md`.
