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
