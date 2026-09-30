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
