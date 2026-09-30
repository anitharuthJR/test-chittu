# Prompt — tulifo.com: correct the Chittu copy and add `/chittu/compare` (drop 1, website half)

Paste everything below the rule into a Claude Code session opened in the `tulifo-website`
repo. It is self-contained; the design it implements is
`docs/superpowers/specs/2026-09-29-chittu-comparison-page-design.md` in the chittu repo
(worktree `~/work_space/claude_worktree/chittu/angry-yalow-621c29`), which you may read for
background but do not need.

---

You are working in `Tulifo/tulifo-website`: an Astro 5 static site (`output: 'static'`,
`build.format: 'file'`, one layout `src/layouts/Base.astro`, plain CSS in
`src/styles/global.css` extracted verbatim from the design mock, content validated with Zod,
Vitest + happy-dom for unit tests, Playwright for end-to-end, Firebase Hosting with a strict
CSP). Read `README.md` first.

## What you are building, and why

Tulifo published two open models on Hugging Face on 27 Sep 2026: `Tulifo/chittu-guard-v0-4b`
and `Tulifo/chittu-story-v0-26m`. The site's `/chittu`, `/research` and `/pinmbo` pages were
generated from the design mock on 28 Sep and still carry the mock's placeholder figures as
facts. The model cards contradict them. Your job has two parts, as two pull requests:

- **PR A — correct the copy** on `/chittu`, `/research` and one sentence on `/pinmbo` so every
  statement matches the published cards. Ship this first; it is independent and urgent.
- **PR B — a new page `/chittu/compare`, "How Chittu compares"**, which renders *comparison
  cards* produced in the chittu repo. The page holds no numbers of its own: every figure,
  version, denominator and caveat comes from a card JSON file. Until the first real cards are
  imported the page has nothing to show, so PR B stays a draft with a preview channel and
  merges together with the first import (Arun will hand you the cards).

The audience is investors and press. They check headline figures against the card behind
them, so the design's rules are: nothing on the page that a card does not hold; a section
renders only when its card exists (never "coming soon"); competitor products appear only as
their own public statements, cited; no invented numbers anywhere, including in copy.

## Ground rules

- Work in a fresh worktree branched from `origin/main` (`claude --worktree` does this).
- TDD: write the failing test, run it, implement, run it green, commit. Small commits.
- **Do not edit `src/styles/global.css`** (it is the extracted design). New styles go in
  scoped `<style>` blocks inside the new components. Use the existing tokens (`--ink`,
  `--mute`, `--rule`, `--mist`, `--tint`, `--blue`, `--card`, `--shadow`) and existing classes
  (`.wrap .sec .sec-mist .stack-m .stack-l .stack-xl .grid .g4 .g3 .stat .num .feat .prose
  .h1-p .h2 .h2-s .lede .aud .pip .muted .mono .btn .btn-p .btn-s .panel .pbar .code .metas
  .meta .step .split .row .hero-p .hero-grid`).
- **No client-side script in this work.** The CSP has no `'unsafe-inline'` for scripts and
  `scripts/check-links.mjs` fails the build on an inline `<script>`; nothing here needs JS.
- Heading order must not skip (h1 → h2 → h3); the link audit fails on a jump. Lighthouse
  accessibility is 100 on every page today and must stay 100 on the pages you touch.
- Every internal `href` must resolve in `dist/` (link audit). That is why cross-links to
  `/chittu/compare` belong in PR B, not PR A.
- Run before every commit that touches pages: `npm test`, `npm run check`, `npm run build`.
  Before each PR: `npm run e2e`, then load the pages in the browser at 1280px and 375px.
- One thing needs Arun's decision, not yours: the current `/chittu` copy says Chittu "feeds
  the interview model" and frames "one model family, two jobs" (interviews + learning). That
  is not verifiable from the model cards. Ask Arun once; if no answer, remove it.

## Facts you may state (from the two published model cards)

| | `Tulifo/chittu-guard-v0-4b` | `Tulifo/chittu-story-v0-26m` |
|---|---|---|
| What it is | LoRA fine-tune of Qwen3-4B-Instruct-2507, fused to bf16; answers a child's message with one of four tokens (`CRISIS` `UNSAFE` `PII` `SPINE`) or a safe reply | from-scratch nanochat GPT: depth 6, vocab 8,192, 512-token context; SFT checkpoint at the root, base under `base/` |
| Parameters | 4B | 26.3M |
| Training data | 5,250 fully synthetic examples written and cross-reviewed by language models; **no real child data**; corpus not published | TinyStories (Microsoft Research, synthetic), GPT-4 rows only, swept by Chittu's own guards: 2,327,256 stories kept of 2,494,822 |
| Licence | Apache-2.0 | Apache-2.0 |
| Released | 27 Sep 2026 | 27 Sep 2026 |
| Layout | standard transformers layout (`config.json`, safetensors shards, `tokenizer.json`) | `model.safetensors`, `config.json`, `load.py` (needs nanochat's model code), `tokenizer/`, `base/` |
| Intended use | research into small local guard models for children's products, always behind deterministic guards and scripted responses; **not** a standalone chatbot, moderation classifier or crisis detector | research into small offline kid-locked story generators; **not** a general-purpose assistant |
| Serves a child today? | no | no |

pinmbo's safety is a deterministic pipeline around a hosted general model: a fixed lexicon,
deterministic maths, scripted crisis / identity / personal-information / secret replies, and
an output filter. A maths turn and a crisis turn reach no model at all. That is the claim the
site may make about pinmbo; "trained on curriculum content and real tutoring conversations"
is not true of anything Tulifo has released.

Links: `https://huggingface.co/Tulifo`, `https://huggingface.co/Tulifo/chittu-guard-v0-4b`,
`https://huggingface.co/Tulifo/chittu-story-v0-26m`.

What the site says today that must go: "3–8B parameters"; "Training records 4B" / "trained on
4 billion records"; "Next run 130B records" / "130 billion records"; "License [LICENSE]"; the
repo `tulifo/chittu` and the bare `https://huggingface.co` link; "curriculum and textbook
content, real tutoring conversations, and synthetic hint and teaching pairs"; "Chittu is the
model behind pinmbo"; on `/pinmbo`, "runs on a model trained on curriculum content and real
tutoring conversations, not on a general chatbot with a filter added".

---

## PR A — copy corrections

### `/chittu` (`src/pages/chittu.astro`) becomes the model-family page

Hero (`.hero-p .hero-grid`), keeping the existing structure:

- `.aud`: **Open models**
- h1: **Chittu is our model family. Its weights are open.**
- lede: *Chittu is the model track behind pinmbo. Two research releases are open on Hugging
  Face today: a small guard model and a from-scratch story model, both trained on synthetic
  data with no real child data in them. Neither serves a child yet. pinmbo's safety comes from
  deterministic guards around whichever model answers, and the open models are our work
  toward putting that safety inside the model.*
- buttons: **View on Hugging Face** → `https://huggingface.co/Tulifo` (primary) · **Read our
  vision** → `/#vision` (secondary). (PR B adds **See how it compares** → `/chittu/compare`.)

Two release panels (`.panel` with `.pbar`, `.code.mono`, `.metas`). Both must be visible
above the fold at 1280px: stack them in the hero's panel column, or keep one in the hero and
put the second in a two-column band directly beneath. Choose whichever reads better against
the mock and say which you chose in the PR.

Guard panel — pbar `Tulifo/chittu-guard-v0-4b` · `Guard model`; snippet:

```python
# Guard model — standard transformers layout
from transformers import AutoModelForCausalLM, AutoTokenizer

repo = "Tulifo/chittu-guard-v0-4b"
tok = AutoTokenizer.from_pretrained(repo)
model = AutoModelForCausalLM.from_pretrained(repo)
```

metas: Parameters **4B** · Training data **5,250 synthetic examples** · Licence **Apache-2.0**
· Released **27 Sep 2026**.

Story panel — pbar `Tulifo/chittu-story-v0-26m` · `Story model`; snippet:

```python
# Story model — the repo ships its own two-function loader.
# Needs nanochat's model code on the path: github.com/karpathy/nanochat
from huggingface_hub import snapshot_download
repo_dir = snapshot_download("Tulifo/chittu-story-v0-26m")
from load import load, story          # load.py is in repo_dir
model, tok = load(repo_dir)
print(story(model, tok, "tell me a story about a brave little sparrow"))
```

metas: Parameters **26.3M** · Training data **2.33M swept stories** · Licence **Apache-2.0** ·
Released **27 Sep 2026**.

Keep each snippet in one place (a constant at the top of the page's frontmatter) so it can be
swapped in one edit: the chittu side runs both snippets before this PR merges and will tell
you if either needs a change.

"Where Chittu is going" (`.grid .g4` of `.step`, three steps, **no figures**):

- `Now` — **Two research releases.** *A 4B guard model and a 26M story model, open on Hugging
  Face, each with a card that lists every known failure.*
- `Next` — **The story model's next milestone.** *A longer training run on rented GPU, then the
  gates in our status ledger before it can ever serve a child: a free-generation quality
  eval, the red-team corpus in every language our guards read, and a signed training record.*
- `Then` — **Safety inside the model, not only around it.** *That is the research direction.
  Every step ships with a card, and open weights stay the rule.*

Feature grid (`.grid .g3 .feats` of `.feat`), replacing all six current items. Section h2:
**What the releases are**; lede: *Two small models, both open, both trained on synthetic
data, both documented to the last failure.*

- **Kid-locked by construction.** *The story model has only ever read children's stories that
  Chittu's own guards swept first. It cannot say what it never read.*
- **Escalates, never improvises.** *The guard model answers a child's message with one of four
  tokens or a safe reply. The tokens trigger scripted responses; the model never writes the
  crisis message itself.*
- **No real child data.** *Both corpora are synthetic. The guard corpus was written and
  cross-reviewed by language models and contains no child's words.*
- **Every release ships with a card.** *Every evaluation generation verbatim, every known
  failure listed, and a human read that is either signed or blank.*
- **Run it yourself.** *Standard transformers weights for the guard model, a two-function
  loader for the story model, MLX and Ollama on a laptop.*
- **Measured in the open.** *How the models compare with their peers, and what those
  comparisons do not show.* (In PR A this item has no link; PR B links it to `/chittu/compare`.)

The "More from Tulifo" band stays. The page `<title>` stays `Chittu — Tulifo’s open language
model` unless Arun wants it changed (the e2e page list asserts it); the meta description
becomes *Tulifo’s open model family: a 4B guard model and a 26M story model, Apache-2.0, on
Hugging Face.*

### `/research` (`src/pages/research.astro`)

- Stat row (`.grid .g4` of `.stat`): **2** *open research releases* · **26M and 4B**
  *parameters in the two models* · **0** *real child records in any training set* ·
  **Apache-2.0** *licence on both*.
- Replace the prose paragraphs "Chittu's first training run used 4 billion records…" and "The
  next run is planned at 130 billion records…" with: *Chittu is our model family and the model
  track behind pinmbo. Two research releases are open on Hugging Face: a 4B guard model
  trained on 5,250 synthetic examples, and a 26M story model trained from scratch on 2.33
  million children's stories that our own guards swept first. Neither contains real child
  data and neither serves a child yet.* Keep "Our papers and benchmark results will be
  published on this page." (PR B adds: *Our first comparisons are published: How Chittu
  compares.* with the link.)
- The `rcard` "Chittu is now open on Hugging Face" stays; its sub-line becomes *Our first
  open-weights releases: a guard model and a story model, trained in-house on synthetic data.*

### `/pinmbo` (`src/pages/pinmbo.astro`), two edits only

- Lede: "built on Chittu, our own kids-focused model" → **built on Chittu, our safety-first
  model stack for children**.
- The feature "Made for children from the model up / pinmbo runs on a model trained on
  curriculum content and real tutoring conversations, not on a general chatbot with a filter
  added." → **Safe whichever model answers.** *pinmbo's safety does not depend on the model:
  deterministic guards and scripted crisis responses wrap every model call, and a maths or
  crisis turn reaches no model at all.*

The home page tile ("built on Chittu, that gives hints instead of answers") is true as written
once the lede above lands; leave it.

### PR A checks

`npm test`, `npm run check`, `npm run build` (the link audit), `npm run e2e`; load `/chittu`,
`/research`, `/pinmbo` at 1280 and 375 next to `design/tulifo-com-v6.0.html`; Lighthouse
accessibility 100 on the three pages. PR title: `copy: Chittu pages state what the model cards
state`. Body: the table above, and the interview-line decision.

---

## PR B — the page `/chittu/compare`

### The card contract (shared with the chittu repo — do not loosen it)

Cards are JSON files produced in the chittu repo under `comparisons/cards/<id>-<date>.json`
(plus a markdown twin `<id>-<date>.md` holding the method and every generation). Two fixtures
with **invented** numbers and `"fixture": true` are the shared test contract; they are
reproduced at the end of this prompt. Put them in `src/content/__fixtures__/comparisons/`
(never in `src/content/comparisons/`).

Add `zod` schema at `src/content/comparisons.ts`:

```ts
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date');
const sha40 = z.string().regex(/^[0-9a-f]{40}$/, '40-hex commit');
const slug = z.string().regex(/^[a-z0-9-]+$/);
const httpsUrl = z.string().url().startsWith('https://');

const System = z.object({
  id: slug, label: z.string().min(1), isChittu: z.boolean(),
  source: z.string().min(1), revision: z.string().min(1),
  params: z.number().int().positive().optional(),
  probes: z.array(z.string().min(1)).min(1),
  notes: z.string().min(1).optional(),
});
const Prompt = z.object({
  id: slug, label: z.string().min(1), source: z.string().min(1),
  count: z.number().int().positive(), seeds: z.array(z.number().int()).min(1),
});
const Metric = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/), probe: slug, label: z.string().min(1),
  unit: z.enum(['percent', 'count']), higherIsBetter: z.boolean(),
  denominator: z.number().int().positive(),
  values: z.record(z.string(), z.number().nullable()),
  counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  notes: z.record(z.string(), z.string().min(1)).optional(),
});
const Control = z.object({ label: z.string().min(1), expected: z.string().min(1), observed: z.string().min(1), passed: z.boolean() });
const HumanRead = z.union([
  z.object({ reviewer: z.null(), date: z.null(), sampleSize: z.null(), findings: z.null() }),
  z.object({ reviewer: z.string().min(1), date: isoDate, sampleSize: z.number().int().positive(), findings: z.string().min(1) }),
]);
const Imported = z.object({ fromCommit: sha40, at: isoDate }).nullable();
const Links = z.object({
  card: z.string().regex(/^\/chittu\/cards\/[a-z0-9-]+\.md$/),
  external: z.array(z.object({ label: z.string().min(1), url: httpsUrl })),
});

const base = {
  schema: z.literal('chittu-comparison-card/1'),
  fixture: z.boolean().optional(),
  id: slug, date: isoDate, title: z.string().min(1), claim: z.string().min(1),
  producedBy: z.object({ repo: z.literal('Tulifo/chittu'), commit: sha40, runner: z.string().min(1) }),
  systems: z.array(System).min(2),
  caveats: z.array(z.string().min(1)).min(1),
  links: Links, imported: Imported,
};

function oneChittu(systems: { isChittu: boolean; id: string }[], ctx: z.RefinementCtx) {
  if (systems.filter((s) => s.isChittu).length !== 1) ctx.addIssue({ code: 'custom', message: 'exactly one system must be isChittu' });
  if (new Set(systems.map((s) => s.id)).size !== systems.length) ctx.addIssue({ code: 'custom', message: 'system ids must be unique' });
}

export const MeasuredCard = z.object({
  ...base,
  kind: z.enum(['behaviour', 'story', 'guard']),
  prompts: z.array(Prompt).min(1),
  method: z.object({ decoding: z.string().min(1), grader: z.string().min(1), judge: z.object({ model: z.string(), revisionDate: isoDate, promptFile: z.string() }).nullable() }),
  metrics: z.array(Metric).min(1),
  controls: z.array(Control),
  humanRead: HumanRead,
}).superRefine((card, ctx) => {
  oneChittu(card.systems, ctx);
  const promptIds = new Set(card.prompts.map((p) => p.id));
  for (const s of card.systems) for (const p of s.probes) if (!promptIds.has(p)) ctx.addIssue({ code: 'custom', message: `system ${s.id} names unknown probe ${p}` });
  for (const m of card.metrics) {
    if (!promptIds.has(m.probe)) ctx.addIssue({ code: 'custom', message: `metric ${m.key} names unknown probe ${m.probe}` });
    const expected = card.systems.filter((s) => s.probes.includes(m.probe)).map((s) => s.id).sort();
    const got = Object.keys(m.values).sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) ctx.addIssue({ code: 'custom', message: `metric ${m.key}: values must cover exactly ${expected.join(', ')}` });
    for (const [id, v] of Object.entries(m.values)) if (v === null && !m.notes?.[id]) ctx.addIssue({ code: 'custom', message: `metric ${m.key}: null for ${id} needs a note` });
  }
});

const Cell = z.object({ value: z.string().min(1), source: httpsUrl, asOf: isoDate });
export const LandscapeCard = z.object({
  ...base,
  kind: z.literal('landscape'),
  columns: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1) })).min(1),
  rows: z.array(z.object({ system: slug, cells: z.record(z.string(), Cell) })).min(2),
}).superRefine((card, ctx) => {
  oneChittu(card.systems, ctx);
  const ids = new Set(card.systems.map((s) => s.id));
  const cols = card.columns.map((c) => c.key).sort();
  for (const r of card.rows) {
    if (!ids.has(r.system)) ctx.addIssue({ code: 'custom', message: `row ${r.system} is not a system` });
    if (JSON.stringify(Object.keys(r.cells).sort()) !== JSON.stringify(cols)) ctx.addIssue({ code: 'custom', message: `row ${r.system} must have every column and no others` });
  }
});

export const Card = z.union([LandscapeCard, MeasuredCard]);
export type Card = z.infer<typeof Card>;
export type MeasuredCard = z.infer<typeof MeasuredCard>;
export type LandscapeCard = z.infer<typeof LandscapeCard>;

export const SECTION_ORDER = ['landscape', 'behaviour', 'story', 'guard'] as const;

/** Latest date per card id, in SECTION_ORDER, fixtures never included. */
export function sectionsFor(cards: Card[]): Card[] {
  const latest = new Map<string, Card>();
  for (const c of cards) {
    if (c.fixture) continue;
    const prev = latest.get(c.id);
    if (!prev || c.date > prev.date) latest.set(c.id, c);
  }
  return SECTION_ORDER.flatMap((kind) => [...latest.values()].filter((c) => c.kind === kind));
}

/** Build-time loader: every JSON under src/content/comparisons/ must validate or the build fails. */
export function loadCards(): Card[] {
  const files = import.meta.glob('./comparisons/*.json', { eager: true }) as Record<string, { default: unknown }>;
  return Object.entries(files).map(([path, mod]) => {
    const parsed = Card.safeParse(mod.default);
    if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    if (parsed.data.fixture) throw new Error(`${path}: a fixture may not live under src/content/comparisons/`);
    return parsed.data;
  });
}
```

Tests in `src/content/comparisons.test.ts` (Vitest). Each is one `it`; the broken variants
are built by spreading the fixture and changing one thing:

- both fixtures parse with `Card.safeParse` → `success: true`;
- removing `denominator` from a metric fails; `caveats: []` fails; a second `isChittu: true`
  fails; a metric whose `values` omit a participating system fails; a metric whose `values`
  include a non-participating system fails; a `null` value without a note fails and with a
  note passes; `humanRead` with only `reviewer` set fails; `imported: { fromCommit: 'abc' }`
  fails; a landscape cell whose `source` is `http://` fails; a landscape row missing a column
  fails; `producedBy.repo: 'Tulifo/other'` fails;
- `sectionsFor` returns `[]` for two fixtures (fixtures never render), keeps `SECTION_ORDER`
  regardless of input order, omits kinds that are absent, and shows only the latest date when
  two cards share an id (use the story fixture twice with `fixture: false` and two dates).

### The importer — `scripts/import-cards.ts`, run as `npm run import:cards -- <chittu-checkout>`

Add `tsx` as a devDependency and the script `"import:cards": "tsx scripts/import-cards.ts"`.
Behaviour, each point a unit test in `scripts/import-cards.test.ts` (run through a temp dir):

- reads `<checkout>/comparisons/cards/*.json`; refuses (non-zero exit, nothing written) if
  any card fails `Card.safeParse` or has `fixture: true`;
- for each valid card: writes `src/content/comparisons/<id>-<date>.json` with `imported` set
  to `{ fromCommit: <git -C <checkout> rev-parse HEAD>, at: <today ISO> }`, and copies the
  markdown twin to `public/chittu/cards/<id>-<date>.md`; refuses if the twin is missing or if
  `links.card` does not equal `/chittu/cards/<id>-<date>.md`;
- copies `<checkout>/comparisons/fixtures/*.json` to `src/content/__fixtures__/comparisons/`
  so the two repos test the same fixtures;
- prints one line per file written: `added`, `updated` or `unchanged`.

### The page — `src/pages/chittu/compare.astro`

`Base` props: title **How Chittu compares — Tulifo**, description *What we measured, against
whom, and what it does not show.*, `page="chittu"`.

Structure:

- Hero (`.hero-p .stack-m`): `.aud` **Research** · h1 **How Chittu compares.** · lede *Chittu's
  safety does not depend on which model answers. Below is what we measured, against whom, on
  what date, and what each measurement does not show. Every figure links to the card it came
  from.*
- Then `sectionsFor(loadCards())`, each rendered by one component. If the list is empty the
  page shows the hero only (that is the correct state before the first import, and a test
  covers it).

`src/components/compare/CardSection.astro` (props `card: MeasuredCard`), a `.sec` with:

1. h2 = `card.title`; a `.lede` = `card.claim`.
2. Headline tiles: a `.grid .g4` of `.stat` for each metric where the Chittu system has a
   value: `.num` shows the value with its unit (`100%`), the `p` shows `label · n of denominator`.
3. The full table (`<table>` with `<caption>`, `<th scope="col">` for metrics with the
   denominator in the header, `<th scope="row">` for systems, Chittu's row first and marked
   with a visible "Chittu" chip, `null` rendered as "—" with the note in a `<td>` title and as
   visible small text).
4. `src/components/compare/Bars.astro` per metric: an inline SVG bar per system, values as
   `<text>`, `aria-hidden="true"` and `role="presentation"` because the table is the accessible
   source; width proportional to value; Chittu's bar in `--blue`, others `--mute`.
5. Controls, if any, as a two-column `<dl>`.
6. Human read, only when `humanRead.reviewer` is set: reviewer, date, sample size, findings.
7. h3 **What this does not show** followed by `<ul>` of the caveats verbatim.
8. Meta line (`.mono .muted`): `measured {date} · chittu@{commit.slice(0,7)} ·` link "full
   card" → `links.card` · one link per `links.external`.

`src/components/compare/LandscapeTable.astro` (props `card: LandscapeCard`): the same shell
(h2, claim, table, caveats, meta) with one row per system in `card.rows` (Chittu's first and
marked), one column per `card.columns`, each cell's `value` followed by a small link
`source (asOf)`; the value `not stated` rendered in `.muted`. No SVG.

Styles: scoped `<style>` in each component; tables scroll horizontally inside a wrapper at
narrow widths (`overflow-x: auto`), never overflow the page; no colour is the only carrier of
meaning.

Add `chittu/compare` to `PAGES` in `scripts/check-links.mjs` and `['/chittu/compare', 'How
Chittu compares — Tulifo']` to the page list in `tests/e2e/pages.spec.ts`.

### Cross-links (PR B only)

- `/chittu` hero: add the button **See how it compares** → `/chittu/compare` (primary; Hugging
  Face becomes secondary), and link the **Measured in the open** feature.
- `/research`: append *Our first comparisons are published: [How Chittu compares](/chittu/compare).*
  and link the "Public reliability benchmarks" feature.
- `src/components/Footer.astro`, Research column: add `<a href="/chittu/compare">Comparisons</a>`.

### Local preview with fixtures

The page must never render a fixture in a build, but you need to see it while developing.
In `loadCards()` allow one dev-only affordance: when `import.meta.env.DEV` is true **and**
`import.meta.env.PUBLIC_CHITTU_PREVIEW_FIXTURES === '1'`, also load
`./__fixtures__/comparisons/*.json` and strip their `fixture` flag for rendering. Add a test
that `loadCards()` throws on a fixture under `src/content/comparisons/` regardless of env, and
a test that `sectionsFor` drops anything still flagged. Run `PUBLIC_CHITTU_PREVIEW_FIXTURES=1
npm run dev` to preview; `npm run build` never sets it.

### PR B checks and merge condition

`npm test`, `npm run check`, `npm run build`, `npm run e2e`; preview with fixtures at 1280 and
375; Lighthouse accessibility 100 on `/chittu/compare`. Open the PR as a **draft** with the
preview channel and a screenshot of the fixture-rendered page. It merges when Arun hands you
the first real cards and `npm run import:cards -- <chittu-checkout>` has written them; commit
the imported JSON and markdown in the same PR. PR title: `feat: /chittu/compare renders the
comparison cards`.

---

## Fixtures (copy verbatim into `src/content/__fixtures__/comparisons/`)

`example-card.json`:

```json
{
  "schema": "chittu-comparison-card/1",
  "fixture": true,
  "id": "story-vs-tinystories",
  "kind": "story",
  "date": "2026-10-02",
  "title": "The story model against TinyStories",
  "claim": "FIXTURE with invented numbers, for tests and local preview only. Never import this as a card.",
  "producedBy": {
    "repo": "Tulifo/chittu",
    "commit": "0000000000000000000000000000000000000000",
    "runner": "llm-kit/compare/story_compare.py"
  },
  "systems": [
    {
      "id": "chittu-story-v0-26m",
      "label": "Chittu story v0 (26M)",
      "isChittu": true,
      "source": "huggingface:Tulifo/chittu-story-v0-26m",
      "revision": "fixture",
      "params": 26300000,
      "probes": ["completion", "requests"],
      "notes": "base/ checkpoint for completions, root (SFT) checkpoint for requests"
    },
    {
      "id": "tinystories-1m",
      "label": "TinyStories-1M",
      "isChittu": false,
      "source": "huggingface:roneneldan/TinyStories-1M",
      "revision": "fixture",
      "params": 1000000,
      "probes": ["completion"]
    },
    {
      "id": "tinystories-33m",
      "label": "TinyStories-33M",
      "isChittu": false,
      "source": "huggingface:roneneldan/TinyStories-33M",
      "revision": "fixture",
      "params": 33000000,
      "probes": ["completion"]
    },
    {
      "id": "tinystories-instruct-33m",
      "label": "TinyStories-Instruct-33M",
      "isChittu": false,
      "source": "huggingface:roneneldan/TinyStories-Instruct-33M",
      "revision": "fixture",
      "params": 33000000,
      "probes": ["requests"],
      "notes": "receives each request through a Summary: adapter; it was never trained on a child's phrasing"
    }
  ],
  "prompts": [
    {
      "id": "completion",
      "label": "the paper's 44 completion prompts",
      "source": "TinyStories 'Evaluation prompts.yaml', sha256 a915216be5516348af9db387c5bb51e8e930e7997eb0543a3de0bf63c7fe81ee",
      "count": 44,
      "seeds": [42, 43, 44]
    },
    {
      "id": "requests",
      "label": "20 requests written as a child types them",
      "source": "llm-kit/nanochat/chittu/story_requests.txt",
      "count": 20,
      "seeds": [42, 43, 44]
    }
  ],
  "method": {
    "decoding": "temperature 0.6, top-k 50; 200 new tokens for completions, 400 for requests, in each model's own tokenizer",
    "grader": "Chittu L1 scan() + L6 passesOutputFilter(), via pnpm story:sweep --fields text",
    "judge": null
  },
  "metrics": [
    {
      "key": "clean_completion",
      "probe": "completion",
      "label": "Would pass Chittu's guards",
      "unit": "percent",
      "higherIsBetter": true,
      "denominator": 132,
      "values": { "chittu-story-v0-26m": 100.0, "tinystories-1m": 93.9, "tinystories-33m": 97.7 },
      "counts": { "chittu-story-v0-26m": 132, "tinystories-1m": 124, "tinystories-33m": 129 }
    },
    {
      "key": "ended_completion",
      "probe": "completion",
      "label": "Reached an ending within the budget",
      "unit": "percent",
      "higherIsBetter": true,
      "denominator": 132,
      "values": { "chittu-story-v0-26m": 89.4, "tinystories-1m": 53.8, "tinystories-33m": 83.3 },
      "counts": { "chittu-story-v0-26m": 118, "tinystories-1m": 71, "tinystories-33m": 110 }
    },
    {
      "key": "clean_requests",
      "probe": "requests",
      "label": "Would pass Chittu's guards",
      "unit": "percent",
      "higherIsBetter": true,
      "denominator": 60,
      "values": { "chittu-story-v0-26m": 100.0, "tinystories-instruct-33m": 95.0 },
      "counts": { "chittu-story-v0-26m": 60, "tinystories-instruct-33m": 57 }
    }
  ],
  "controls": [],
  "humanRead": { "reviewer": null, "date": null, "sampleSize": null, "findings": null },
  "caveats": [
    "The rubric quality of these stories has not been judged by a model or, until the human read is filled, by a person. Hygiene says what the guards would refuse, not whether the story is good.",
    "No perplexity: no text exists that neither model family saw.",
    "Different corpora: the TinyStories models trained on the V1 mixed GPT-3.5/GPT-4 data; Chittu on GPT-4 rows swept by its own guards. Sizes differ across the ladder.",
    "The Instruct model received a translated prompt it was never trained on.",
    "chittu-story-v0-26m has never served a child and clears none of the gates that would let it."
  ],
  "links": {
    "card": "/chittu/cards/story-vs-tinystories-2026-10-02.md",
    "external": [
      { "label": "Tulifo/chittu-story-v0-26m", "url": "https://huggingface.co/Tulifo/chittu-story-v0-26m" },
      { "label": "roneneldan/TinyStories-33M", "url": "https://huggingface.co/roneneldan/TinyStories-33M" }
    ]
  },
  "imported": null
}
```

`example-landscape.json`:

```json
{
  "schema": "chittu-comparison-card/1",
  "fixture": true,
  "id": "landscape",
  "kind": "landscape",
  "date": "2026-10-02",
  "title": "Where Chittu sits",
  "claim": "FIXTURE with invented cells, for tests and local preview only. Never import this as a card.",
  "producedBy": {
    "repo": "Tulifo/chittu",
    "commit": "0000000000000000000000000000000000000000",
    "runner": "hand-authored, every cell re-verified against its source on the asOf date"
  },
  "systems": [
    { "id": "pinmbo", "label": "pinmbo (Chittu)", "isChittu": true, "source": "https://tulifo.com/pinmbo", "revision": "2026-10-02", "probes": ["landscape"] },
    { "id": "example-product", "label": "Example product", "isChittu": false, "source": "https://example.com", "revision": "2026-10-02", "probes": ["landscape"] }
  ],
  "columns": [
    { "key": "safety_layer", "label": "Where safety lives" },
    { "key": "open_weights", "label": "Open weights" },
    { "key": "crisis", "label": "What happens on a crisis message" }
  ],
  "rows": [
    {
      "system": "pinmbo",
      "cells": {
        "safety_layer": { "value": "deterministic pipeline around any model; crisis, identity, PII and secret replies scripted, never generated", "source": "https://tulifo.com/pinmbo", "asOf": "2026-10-02" },
        "open_weights": { "value": "yes: two models, Apache-2.0", "source": "https://huggingface.co/Tulifo", "asOf": "2026-10-02" },
        "crisis": { "value": "scripted reply with helplines, chat locked, parent flagged by category only", "source": "https://tulifo.com/pinmbo", "asOf": "2026-10-02" }
      }
    },
    {
      "system": "example-product",
      "cells": {
        "safety_layer": { "value": "proprietary layer on a foundation model", "source": "https://example.com/safety", "asOf": "2026-10-02" },
        "open_weights": { "value": "no", "source": "https://example.com", "asOf": "2026-10-02" },
        "crisis": { "value": "not stated", "source": "https://example.com/safety", "asOf": "2026-10-02" }
      }
    }
  ],
  "caveats": [
    "This is a table of what each product says about itself, cited to the vendor's own page on the date shown. Nothing here was measured by Tulifo.",
    "\"not stated\" means the vendor's public materials do not say; it is not a claim that the feature is absent."
  ],
  "links": {
    "card": "/chittu/cards/landscape-2026-10-02.md",
    "external": [
      { "label": "Kids AI model landscape, Aug 2026 (research note)", "url": "https://tulifo.com/chittu/cards/landscape-2026-10-02.md" }
    ]
  },
  "imported": null
}
```

## Done when

PR A is merged and `/chittu`, `/research`, `/pinmbo` state only what the cards state. PR B is
a reviewed draft with a preview channel showing the fixture-rendered page, all checks green,
waiting only on the first `import:cards` run.

## Snippet verification (chittu side)

Run on 2026-09-30 from `llm-kit/compare` (`uv run --frozen python`, torch 2.9.1, transformers 5.17.0):

- **Story snippet:** ran end to end. `snapshot_download("Tulifo/chittu-story-v0-26m")` resolved
  revision `4f11284f8ebc19348ce2885bfea66eb13c8717cc`; the repo's `load.py` loaded the SFT
  checkpoint (26,345,726 parameters) with `llm-kit/nanochat` on the path, and
  `story(model, tok, "tell me a story about a brave little sparrow")` printed a story beginning
  "Once upon a time, there was a brave little sparrow named Lucy." The base checkpoint loads the
  same way (`load(repo_dir, "base")`); the comparison run uses both.
- **Guard snippet:** the tokenizer and the config resolve through transformers
  (`Qwen3ForCausalLM`, `architectures: ['Qwen3ForCausalLM']`), and the model class builds from the
  config on the meta device. The weights (8 GB) were not downloaded, so no generation was run.
- **Changes the snippets need:** none.
