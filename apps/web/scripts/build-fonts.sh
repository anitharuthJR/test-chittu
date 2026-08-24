#!/usr/bin/env bash
#
# Build the self-hosted brand faces.
#
# The obvious way to use these fonts is a <link> to fonts.googleapis.com, and it
# is the one thing we must not do: it sends every child's IP address to a third
# party on every page load. That is the same rule as "no analytics SDK of any
# kind" (architecture §2.1), and a live DPDP question rather than a theoretical
# one.
#
# So the WOFF2 files are committed. This script is how they are regenerated, so
# "where did these binaries come from?" has an answer that is not "someone
# downloaded them once, probably".
#
# All four families are SIL Open Font License 1.1, which permits redistribution
# provided the licence travels with the files. It does — src/fonts/OFL/.
#
# Requires fonttools with WOFF2 support:
#   python3 -m venv .venv && .venv/bin/pip install "fonttools[woff]" brotli
#   PATH="$PWD/.venv/bin:$PATH" ./scripts/build-fonts.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="src/fonts"
PNPM="$(cd ../.. && pwd)/node_modules/.pnpm"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT/OFL"

command -v pyftsubset >/dev/null || {
  echo "pyftsubset not found — see the header of this script." >&2; exit 1; }

src() { echo "$PNPM/@fontsource$1+$2@5.3.0/node_modules/@fontsource$1/$2"; }

# Google's `latin` subset, verbatim. Nunito and IBM Plex Mono render text we do
# NOT control — a child's typing, a model's code block — so their coverage is
# not narrowed to "characters we have seen". Trimming those would render tofu
# the first time a child typed something we had not anticipated, and the failure
# would look like a bug in the child's language rather than in our build.
#
# Google's `latin` range, verbatim.
#
# It was briefly extended with U+2192 and U+21B3 — the trace strip joins
# pipeline layers with `→` and opens with `↳` — before checking whether the
# sources have them. They do not: neither arrow exists in ANY subset of Nunito,
# Baloo 2 or IBM Plex Mono, so there was nothing to keep. Those two characters
# render from a system font, which `fonts.test.ts` records as a known fallback
# rather than leaving as a surprise.
#
# Worth remembering how that nearly slipped through: measuring the glyph's
# width in a browser said it was present, because the system fallback was also
# monospace and the advance matched. Only the cmap of the built file settles it,
# which is why this script now emits coverage.json.
LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

# The rupee sign lives in `latin-ext`, not `latin`. This is an India-first
# product whose maths lessons talk about money, and ₹ arriving mid-sentence in a
# different face at 15.5px is far more visible than an arrow in a 9.5px trace.
# One codepoint, pulled from the ext subset and given its own unicode-range.
EXTRA='U+20B9'

COMMON=(--layout-features='*' --no-hinting --desubroutinize --flavor=woff2)

# The weight AXIS is a different question from character coverage. The variable
# faces ship 200–1000; the design uses 400–800 for body and 700–800 for display,
# so the rest is instanced away first. Worth ~13% on Nunito and more on Baloo 2,
# which needs only a sliver of its range.
narrow() {   # narrow <input.woff2> <wght range> <output.woff2>
  python3 -m fontTools.varLib.instancer "$1" "wght=$2" -o "$TMP/inst.ttf" >/dev/null
  pyftsubset "$TMP/inst.ttf" --unicodes="$LATIN" "${COMMON[@]}" --output-file="$3"
}

echo "→ Nunito — body, variable, wght 400–800"
narrow "$(src -variable nunito)/files/nunito-latin-wght-normal.woff2" \
  "400:800" "$OUT/nunito-latin-var.woff2"

echo "→ Baloo 2 — display, variable, wght 700–800"
narrow "$(src -variable baloo-2)/files/baloo-2-latin-wght-normal.woff2" \
  "700:800" "$OUT/baloo2-latin-var.woff2"

echo "→ Nunito ₹ — one glyph from latin-ext, for money in maths lessons"
python3 -m fontTools.varLib.instancer \
  "$(src -variable nunito)/files/nunito-latin-ext-wght-normal.woff2" \
  "wght=400:800" -o "$TMP/ext.ttf" >/dev/null
pyftsubset "$TMP/ext.ttf" --unicodes="$EXTRA" "${COMMON[@]}" \
  --output-file="$OUT/nunito-ext-rupee-var.woff2"

echo "→ IBM Plex Mono 400 — labels, traces, and model code (no variable exists)"
pyftsubset "$(src '' ibm-plex-mono)/files/ibm-plex-mono-latin-400-normal.woff2" \
  --unicodes="$LATIN" "${COMMON[@]}" --output-file="$OUT/plexmono-latin-400.woff2"

# The one place a TEXT-based subset is safe, because the Tamil in this product
# is exactly one word: the brand mark சிட்டு. Not user text, not model text — a
# logotype. 38 KB of Tamil for four letterforms would be indefensible on a
# ₹8,000 phone; subset, it is about 2 KB.
#
# If Tamil ever appears anywhere else in the UI, this subset must be regenerated
# with the new string — and `fonts.test.ts` will fail first, which is the point.
echo "→ Baloo Thambi 2 Tamil 800 — the brand mark only"
printf 'சிட்டு' > "$TMP/brand.txt"
pyftsubset "$(src '' baloo-thambi-2)/files/baloo-thambi-2-tamil-800-normal.woff2" \
  --text-file="$TMP/brand.txt" "${COMMON[@]}" \
  --output-file="$OUT/baloothambi2-tamil-800-brand.woff2"

# What each built file actually covers, read back from its cmap rather than
# assumed from the arguments above. `fonts.test.ts` asserts against this, so a
# character the UI renders but the subset dropped fails the suite instead of
# quietly falling back to a system face on a child's phone.
echo "→ coverage manifest"
python3 - "$OUT" <<'PY'
import json, sys, pathlib
from fontTools.ttLib import TTFont
out = pathlib.Path(sys.argv[1])
manifest = {}
for f in sorted(out.glob('*.woff2')):
    manifest[f.name] = sorted(TTFont(f).getBestCmap().keys())
(out / 'coverage.json').write_text(json.dumps(manifest, indent=0) + '\n')
print(f"   {len(manifest)} faces, {sum(len(v) for v in manifest.values())} codepoints")
PY

echo "→ licences"
cp "$(src -variable nunito)/LICENSE"  "$OUT/OFL/Nunito.txt"
cp "$(src -variable baloo-2)/LICENSE" "$OUT/OFL/Baloo2.txt"
cp "$(src '' ibm-plex-mono)/LICENSE"  "$OUT/OFL/IBMPlexMono.txt"
cp "$(src '' baloo-thambi-2)/LICENSE" "$OUT/OFL/BalooThambi2.txt"

echo
total=0
for f in "$OUT"/*.woff2; do
  s=$(stat -f%z "$f"); total=$((total + s))
  printf "  %7.1f KB  %s\n" "$(echo "scale=2; $s/1024" | bc)" "$(basename "$f")"
done
printf "  %7.1f KB  TOTAL\n" "$(echo "scale=2; $total/1024" | bc)"
