import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

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
