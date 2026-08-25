/**
 * The ops console, rendered on the server.
 *
 * WHY NOT IN apps/web. That is the child's bundle, held to 100 KB gzipped and
 * deliberately thin — `render-guard.ts` does not even import the safety kernel,
 * because doing so would publish L1_PATTERNS to every child's browser. Ops
 * tooling has no business in that artifact, and shipping it there would put the
 * routing catalogue and the operator login on a page nine-year-olds load.
 *
 * So: plain HTML from the API, no build step, no framework, no client
 * JavaScript at all. Forms post and the server redirects. That also means the
 * console cannot be broken by a bundler change, and there is no second
 * dependency tree to keep patched.
 *
 * EVERYTHING INTERPOLATED IS ESCAPED. Reasons and operator names come from the
 * database and are written by people; `esc` is applied at every boundary and a
 * test posts `<script>alert(1)</script>` as a reason and greps the rendered page.
 */

import { BANDS, COUNTRIES, type RouterCategory } from '@chittu/contracts';
import { CATEGORIES, MODEL_CATALOGUE, type ResolvedCells, cellFor } from '../providers/cells.js';
import { DEFAULT_CELLS } from '../providers/router.js';

/** "an explorer", "a builder". Small, but the page is read by people. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLE = `
:root{--ink:#1a1a2e;--dim:#6b6b7b;--line:#e4e2da;--bg:#FDFCF8;--accent:#3d3d8f;--warn:#8f3d3d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.35rem;margin:0 0 .25rem}
h2{font-size:1rem;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
  margin:2.25rem 0 .6rem;font-weight:600}
.sub{color:var(--dim);margin:0 0 1.75rem}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dim);padding:.45rem .6rem;border-bottom:1px solid var(--line)}
td{padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.tag{display:inline-block;font-size:11px;padding:.1rem .4rem;border-radius:3px;
  background:#eceaf6;color:var(--accent)}
.tag.default{background:#f0efe9;color:var(--dim)}
form.card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:1.1rem}
label{display:block;font-size:12px;color:var(--dim);margin:.7rem 0 .2rem}
select,input[type=text],input[type=password]{width:100%;padding:.45rem .55rem;
  border:1px solid var(--line);border-radius:4px;font:inherit;background:#fff}
button{margin-top:1.1rem;padding:.5rem 1.1rem;border:0;border-radius:4px;
  background:var(--accent);color:#fff;font:inherit;cursor:pointer}
.row{display:flex;gap:1rem;flex-wrap:wrap}.row>div{flex:1 1 10rem}
.err{background:#fdf0f0;border:1px solid #e8cccc;color:var(--warn);
  padding:.7rem .9rem;border-radius:4px;margin-bottom:1rem}
.note{color:var(--dim);font-size:13px;margin-top:.5rem}
.who{float:right;font-size:13px;color:var(--dim)}
.who form{display:inline}
.who button{background:none;color:var(--accent);padding:0;margin:0;
  text-decoration:underline;font-size:13px}
/* The triage cell: two or three selects and a button, in a column that has to
   share a table row with a wrapped shape. Without this they stack with a
   button stranded on its own line and the row grows to five lines. */
form.triage{display:flex;flex-direction:column;gap:.35rem}
form.triage label{margin:0;display:flex;flex-direction:column;gap:.15rem}
form.triage button{margin-top:.4rem;padding:.35rem .8rem;font-size:13px}
td form.triage select{font-size:13px;padding:.3rem .4rem}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Chittu ops</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return shell('Sign in', `
<h1>Chittu ops</h1>
<p class="sub">Routing console. Changes are recorded against your name.</p>
${error === undefined ? '' : `<div class="err">${esc(error)}</div>`}
<form class="card" method="post" action="/ops/login">
  <label for="token">Operator token</label>
  <input id="token" name="token" type="password" autocomplete="off" autofocus>
  <button type="submit">Sign in</button>
  <p class="note">Tokens are configured per operator in the deployment
  environment. There is no self-service reset.</p>
</form>`);
}

export interface RoutingView {
  readonly operator: string;
  readonly resolved: ResolvedCells;
  readonly history: readonly {
    category: string; provider: string; model: string;
    band: string | null; country: string | null;
    changed_by: string; reason: string; changed_at: Date;
  }[];
  readonly preview?: { band: string; country: string } | undefined;
  readonly error?: string | undefined;
}

function options(values: readonly string[], selected?: string, blank?: string): string {
  return (blank === undefined ? '' : `<option value="">${esc(blank)}</option>`)
    + values.map((v) =>
      `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

export function routingPage(v: RoutingView): string {
  const ctx = v.preview !== undefined && v.preview.band !== '' && v.preview.country !== ''
    ? { band: v.preview.band as never, country: v.preview.country as never }
    : undefined;

  const effective = CATEGORIES.map((c: RouterCategory) => {
    const cell = ctx === undefined ? v.resolved.cells[c] : cellFor(v.resolved, c, ctx);
    const isDefault = cell.provider === DEFAULT_CELLS[c].provider
      && cell.model === DEFAULT_CELLS[c].model;
    return `<tr><td class="mono">${esc(c)}</td>
      <td class="mono">${esc(cell.provider)}/${esc(cell.model)}</td>
      <td><span class="tag${isDefault ? ' default' : ''}">${isDefault ? 'compiled default' : 'override'}</span></td>
      <td class="mono" style="color:var(--dim)">${esc(cell.promptVersion)}</td></tr>`;
  }).join('');

  const scoped = v.resolved.scoped.length === 0
    ? '<p class="note">No overrides. Every category is on its compiled default.</p>'
    : `<table><tr><th>category</th><th>scope</th><th>model</th><th>from</th></tr>${
      v.resolved.scoped.map((e) => {
        const scope = [e.country, e.band].filter((x) => x !== null).join(' / ');
        return `<tr><td class="mono">${esc(e.category)}</td>
          <td class="mono">${scope === '' ? '<span style="color:var(--dim)">all</span>' : esc(scope)}</td>
          <td class="mono">${esc(e.cell.provider)}/${esc(e.cell.model)}</td>
          <td><span class="tag">${esc(e.origin)}</span></td></tr>`;
      }).join('')}</table>`;

  const problems = v.resolved.problems.length === 0 ? '' :
    `<div class="err"><strong>Rejected configuration — the compiled default is in use:</strong>
      <ul>${v.resolved.problems.map((p) => `<li class="mono">${esc(p)}</li>`).join('')}</ul></div>`;

  const pairs = Object.entries(MODEL_CATALOGUE)
    .flatMap(([p, models]) => models.map((m) => `${p}:${m}`));

  const history = v.history.length === 0
    ? '<p class="note">Nothing changed yet.</p>'
    : `<table><tr><th>when</th><th>category</th><th>scope</th><th>model</th><th>who</th><th>why</th></tr>${
      v.history.map((h) => {
        const scope = [h.country, h.band].filter((x) => x !== null).join(' / ');
        return `<tr><td class="mono" style="white-space:nowrap">${esc(h.changed_at.toISOString().slice(0, 16).replace('T', ' '))}</td>
          <td class="mono">${esc(h.category)}</td>
          <td class="mono">${scope === '' ? '<span style="color:var(--dim)">all</span>' : esc(scope)}</td>
          <td class="mono">${esc(h.provider)}/${esc(h.model)}</td>
          <td>${esc(h.changed_by)}</td><td>${esc(h.reason)}</td></tr>`;
      }).join('')}</table>`;

  return shell('Routing', `
<div class="who">${esc(v.operator)} ·
  <form method="post" action="/ops/logout"><button type="submit">sign out</button></form></div>
<h1>Routing</h1>
<p class="sub">Which model answers which turn. Clearance is checked separately,
per child, and can still refuse a cell chosen here.</p>

${problems}
${v.error === undefined ? '' : `<div class="err">${esc(v.error)}</div>`}

<h2>Effective ${ctx === undefined ? '(no child in mind)'
    : `for ${esc(article(String(ctx.band)))} in ${esc(ctx.country)}`}</h2>
<table><tr><th>category</th><th>model</th><th></th><th>prompt</th></tr>${effective}</table>
<form method="get" action="/ops/routing" style="margin-top:.9rem">
  <div class="row">
    <div><label for="pc">Preview country</label>
      <select id="pc" name="country">${options([...COUNTRIES], v.preview?.country, 'none')}</select></div>
    <div><label for="pb">Preview band</label>
      <select id="pb" name="band">${options([...BANDS], v.preview?.band, 'none')}</select></div>
    <div style="flex:0 0 auto;align-self:end"><button type="submit">Preview</button></div>
  </div>
</form>

<h2>Overrides in place</h2>
${scoped}

<h2>Change a cell</h2>
<form class="card" method="post" action="/ops/routing">
  <div class="row">
    <div><label for="category">Category</label>
      <select id="category" name="category">${options([...CATEGORIES])}</select></div>
    <div><label for="pair">Model</label>
      <select id="pair" name="pair">${options(pairs)}</select></div>
  </div>
  <div class="row">
    <div><label for="country">Country <span style="opacity:.7">(blank = everywhere)</span></label>
      <select id="country" name="country">${options([...COUNTRIES], undefined, 'all countries')}</select></div>
    <div><label for="band">Band <span style="opacity:.7">(blank = every band)</span></label>
      <select id="band" name="band">${options([...BANDS], undefined, 'all bands')}</select></div>
  </div>
  <label for="reason">Reason</label>
  <input id="reason" name="reason" type="text"
    placeholder="why this change, in a sentence someone reading an incident review would want">
  <button type="submit">Record change</button>
  <p class="note">Recorded against <strong>${esc(v.operator)}</strong>. Takes effect
  when the API restarts — cells are read once at boot, because routing that
  changes under a turn in flight is worse than routing that needs a restart.</p>
</form>

<h2>History</h2>
${history}`);
}

// ---------------------------------------------------------------------------
// The signals queue (phase 4)
// ---------------------------------------------------------------------------

/**
 * The vocabularies an operator picks from. All three are enums in the schema,
 * so a free-text field here would only produce a database error later, in a
 * language nobody wants to read.
 */
export const FAILURE_CLASSES: readonly string[] = Object.freeze([
  'OVER_REFUSAL', 'UNDER_REFUSAL', 'WRONG_TOKEN', 'HALLUCINATION', 'L6_CATCH',
  'CLASSIFIER_PARSE', 'PRACTICE_LOOP_STUCK', 'BLOCK_GRAMMAR', 'QUALITY_DEGRADED',
]);
export const TOKENS: readonly string[] = Object.freeze(
  ['CRISIS', 'SPINE', 'UNSAFE', 'PII', 'NONE']);
/** The five values `training_example_label_vocab` accepts. `null` is legal too. */
export const LABELS: readonly string[] = Object.freeze(
  ['CRISIS', 'SPINE', 'UNSAFE', 'PII', 'SAFE']);
export const LAYERS: readonly string[] = Object.freeze([
  'L1_LEXICON', 'MATH_LOOP', 'MATH_ENGINE', 'CORPUS', 'SUBJECT',
  'L2_CLASSIFIER', 'L5_SANDBOX', 'L6_FILTER', 'RENDER',
]);

export interface SignalsView {
  readonly operator: string;
  readonly operatorCount: number;
  readonly ready: readonly {
    handle: string; shape: string; sightings: number; k_sessions: number;
    observed_layer: string | null; observed_token: string | null;
    failure_class: string | null; band: string | null; country: string | null;
  }[];
  readonly subFloor: number;
  readonly promoted: readonly {
    id: string; shape: string; failure_class: string;
    expected_token: string | null; observed_token: string | null; examples: number;
  }[];
  readonly pending: readonly {
    id: string; slice: string; prompt: string; completion: string;
    label: string | null; split: string; authored_by: string;
  }[];
  readonly error?: string | undefined;
  /** The submitted body, so a rejected form does not throw away typed work. */
  readonly draft?: Record<string, string> | undefined;
}

/** NULL means "not always the same", which is not the same as blank. */
const varies = (v: string | null): string =>
  v === null ? '<span style="color:var(--dim)">varies</span>' : esc(v);

export function signalsPage(v: SignalsView): string {
  const d = (k: string): string => esc(v.draft?.[k] ?? '');

  const queue = v.ready.length === 0
    ? '<p class="note">Nothing has reached the floor yet.</p>'
    : `<table><tr><th style="width:30%">shape</th><th>seen</th><th>layer</th><th>token</th>
         <th>class</th><th>band</th><th>where</th><th style="width:22%"></th></tr>${
  v.ready.map((r) => `<tr>
        <td class="mono">${esc(r.shape)}</td>
        <td class="mono" title="${r.k_sessions} distinct sessions, then the count froze at the floor">${r.sightings}</td>
        <td class="mono">${varies(r.observed_layer)}</td>
        <td class="mono">${varies(r.observed_token)}</td>
        <td class="mono">${varies(r.failure_class)}</td>
        <td>${varies(r.band)}</td>
        <td>${varies(r.country)}</td>
        <td><form method="post" action="/ops/signals/promote" class="triage">
          <input type="hidden" name="handle" value="${esc(r.handle)}">
          <label>what went wrong<select name="failure_class">${options(FAILURE_CLASSES)}</select></label>
          <label>should have been<select name="expected_token">${options(TOKENS)}</select></label>
          ${r.observed_layer === null
    ? `<label>which layer<select name="observed_layer">${options(LAYERS)}</select></label>` : ''}
          <button type="submit">Triage</button>
        </form></td></tr>`).join('')}</table>`;

  const authored = v.promoted.length === 0
    ? '<p class="note">Nothing triaged yet.</p>'
    : v.promoted.map((p) => `<form class="card" method="post" action="/ops/signals/examples"
        style="margin-bottom:1rem">
      <input type="hidden" name="signal_id" value="${esc(p.id)}">
      <div class="mono" style="font-size:15px">${esc(p.shape)}</div>
      <p class="note" style="margin:.3rem 0 0">
        ${esc(p.failure_class)} · saw ${varies(p.observed_token)} ·
        should have been ${esc(p.expected_token ?? '—')} ·
        ${p.examples} example${p.examples === 1 ? '' : 's'} so far</p>
      <div class="row">
        <div><label for="s-${esc(p.id)}">Slice</label>
          <input id="s-${esc(p.id)}" name="slice" type="text" value="${d('slice')}"
            placeholder="grief · sex-ed-boundary · exam-nerves"></div>
        <div><label for="l-${esc(p.id)}">Label</label>
          <select id="l-${esc(p.id)}" name="label">${options(LABELS, undefined, 'no label')}</select></div>
        <div><label for="sp-${esc(p.id)}">Split</label>
          <select id="sp-${esc(p.id)}" name="split">${options(['train', 'val', 'eval_holdout'])}</select></div>
      </div>
      <label for="p-${esc(p.id)}">What a child types</label>
      <input id="p-${esc(p.id)}" name="prompt" type="text" value="${d('prompt')}"
        placeholder="write what a child types, never a sentence a child typed">
      <label for="c-${esc(p.id)}">What Chittu should say</label>
      <input id="c-${esc(p.id)}" name="completion" type="text" value="${d('completion')}">
      <button type="submit">Author example</button>
      <p class="note">Recorded against <strong>${esc(v.operator)}</strong> as the author, which
      means you cannot be the one who approves it.</p>
    </form>`).join('');

  const review = v.pending.length === 0
    ? '<p class="note">Nothing waiting.</p>'
    : `<table><tr><th>slice</th><th>prompt</th><th>answer</th><th>label</th>
         <th>split</th><th>by</th><th></th></tr>${
  v.pending.map((e) => `<tr>
        <td class="mono">${esc(e.slice)}</td>
        <td>${esc(e.prompt)}</td>
        <td>${esc(e.completion)}</td>
        <td class="mono">${esc(e.label ?? '—')}</td>
        <td class="mono">${esc(e.split)}</td>
        <td>${esc(e.authored_by)}</td>
        <td>${e.authored_by.trim().toLowerCase() === v.operator.trim().toLowerCase()
    ? '<span class="note">yours — needs someone else</span>'
    : `<form method="post" action="/ops/examples/review">
             <input type="hidden" name="example_id" value="${esc(e.id)}">
             <button type="submit" name="state" value="APPROVED">Approve</button>
             <button type="submit" name="state" value="REJECTED"
               style="background:var(--warn)">Reject</button>
           </form>`}</td></tr>`).join('')}</table>`;

  return shell('Signals', `
<div class="who">${esc(v.operator)} ·
  <form method="post" action="/ops/logout"><button type="submit">sign out</button></form></div>
<h1>Signals</h1>
<p class="sub">Shapes the pipeline handled badly, and the examples authored to fix them.
A shape appears here only once <strong>25 distinct sessions</strong> have produced it —
below that there is no shape stored to show.</p>

${v.error === undefined ? '' : `<div class="err">${esc(v.error)}</div>`}

<h2>Ready to triage</h2>
${queue}
<p class="note">Ordered by how often a shape is seen, not by session count — the session
count stops at ${25} by design, so it is the same on every row here.
${v.subFloor > 0
    ? `${v.subFloor} more shape${v.subFloor === 1 ? ' is' : 's are'} being counted and
       ${v.subFloor === 1 ? 'has' : 'have'} not reached the floor. There is nothing to show
       about ${v.subFloor === 1 ? 'it' : 'them'} yet, which is the point of the floor.`
    : 'No other shapes are being counted.'}</p>

<h2>Triaged — author examples</h2>
${authored}

<h2>Waiting for a second pair of eyes</h2>
${v.operatorCount < 2
    ? `<div class="err">Only one operator is configured, so nothing here can ever be
       approved: an example needs a reviewer who is not its author. Configure a second
       operator in <code>CHITTU_OPS_TOKENS</code>.</div>` : ''}
${review}`);
}
