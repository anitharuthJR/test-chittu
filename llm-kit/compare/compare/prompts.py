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
