# Distillation pilot: the local 8B is not good enough to be the teacher

**Date:** 2026-08-23 · **Script:** `distill.py` · **Teacher tried:** `qwen3:8b` via Ollama

## Why we tried

`VARIANCE-REPORT-5runs.md` showed the bottleneck is dataset size (680 vs the
6,000–10,000 in `docs/chittu-local-llm-plan.md` §3). §3.1 says to distil from
chittu-v3's Sonnet pipeline — "your prototype is the teacher model" — but that needs
an API key. The local 8B was the free stand-in: it scores SAFE 8/9 versus the 4B
student's 6/9, so on paper it is the stronger model.

## Pilot 1 — 20 requested, 10 kept (25% yield)

Rejects were 28× "no CHIPS". Cause was **truncation**, not disobedience:
`num_predict: 220` cut replies off mid-sentence before they reached the closing block.

The pilot also exposed **two holes in the quality gate**, both of which had *passed*
malformed examples through:

- Unclosed tags (`[FACT]text` with no `[/FACT]`) survived a bracket-balance check,
  because each tag contributes one `[` and one `]` whether or not it is closed.
  An unclosed block reaches a child as literal markup.
- `[STEPS]1. Breathe. 2. Try one part.` — numbered items instead of the `|` delimiter.
  CLAUDE.md lists that separator as regression-locked; it truncated lessons once before.

Both are now rejected explicitly, and `num_predict` was raised to 400.

## Pilot 2 — 20 requested, 20 kept (100% yield), and that is the problem

Format compliance is now perfect. Content is not:

1. **Formulaic.** All four sampled replies had the identical shape:
   `[BIG]emoji[/BIG]` → "You know how…" → `[FACT]` → "Your turn —" → `[CHIPS]`.
   The few-shot examples are being copied structurally. A student trained on this
   learns one rigid template rather than how to teach.
2. **Band collapse.** Thinker-band (13–17) replies read like Explorer-band ones —
   *"The moon is like a giant ball that's super far away!"* — despite the band rule
   saying "never babyish". Age adaptation, a core product requirement, is absent.
3. **Invented facts — the disqualifying one.**
   - *why paper cuts hurt* → "cuts tiny blood vessels". They hurt because they are
     shallow and expose nerve endings *without* much bleeding.
   - *how long to drive to the moon* → chips `1 day!|1 week!`, neither correct and no
     correct option offered.

Requirement §5's Truth Wall is absolute: never invent facts, numbers, dates or names.
Distilling 1,200 examples of invented numbers would train the student to break it.
A format gate cannot catch this; only a stronger teacher can avoid producing it.

## Conclusion

**Do not mass-distil from the local 8B.** It is stronger than the student at *scoring*
but not at *authoring*, and the teaching half of the dataset is exactly where factual
accuracy and pedagogical variety matter.

Paths that remain open, in order of value:

1. **Sonnet as teacher (plan §3.1).** `distill.py --teacher claude` is implemented and
   ready; it needs `ANTHROPIC_API_KEY` exported in the environment. Rough cost for
   ~5,000 examples at Sonnet pricing: ~$16 (≈₹1,400), inside the plan's ₹0–4,000 budget.
2. **Hand-authored teaching examples.** Slower per example, highest quality; this is how
   every existing SAFE row in `generate_dataset.py` was written.
3. **Guard-side expansion — free and reliable now.** Guard rows need no teacher at all:
   their targets are the fixed tokens. Diversity there is hand-authorable, and the
   guard categories are both the safety-critical ones and among the least stable
   (UNSAFE ranged 5–10 across seeds).

`distill.py` is kept in the kit with its gate intact — it is the right tool the moment
a good teacher is available.
