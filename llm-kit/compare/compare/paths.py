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
