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
import { handle, type OpsActionRow, type UsersView } from './users.js';

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
/* Users. Tiles for the totals, and one table where a family is a heavier row
   with its children indented beneath it — the alternative, two tables joined by
   a handle, makes an operator do the join in their head. */
nav.tabs{margin:-.25rem 0 1.5rem;font-size:13px}
nav.tabs a{color:var(--dim);text-decoration:none;margin-right:1rem;
  padding-bottom:.2rem;border-bottom:2px solid transparent}
nav.tabs a:hover{color:var(--accent)}
nav.tabs a.on{color:var(--ink);border-bottom-color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));
  gap:.6rem;margin:.4rem 0 1.5rem}
.tile{background:#fff;border:1px solid var(--line);border-radius:6px;padding:.65rem .8rem}
.tile b{display:block;font-size:1.45rem;font-weight:600;line-height:1.25}
.tile span{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.tile.warn b{color:var(--warn)}
tr.fam td{background:#f7f6f0;border-top:1px solid var(--line)}
tr.kid td:first-child{padding-left:1.6rem}
td.num{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
th.num{text-align:right}
.pager{display:flex;gap:1rem;align-items:center;margin-top:1.1rem;font-size:13px;
  color:var(--dim)}
.pager a{color:var(--accent)}
tr.edit td{background:#fbfaf5;padding:1rem .6rem}
tr.edit form{max-width:52rem}
tr.edit form+form{margin-top:1.4rem;padding-top:1.1rem;border-top:1px solid var(--line)}
form.danger{background:#fdf7f7;border:1px solid #e8cccc;border-radius:6px;padding:.9rem 1rem}
form.danger strong{color:var(--warn)}
button.warn{background:var(--warn)}
a.cancel{margin-left:.9rem;font-size:13px;color:var(--dim)}
.ok{background:#f2f7f2;border:1px solid #cfe0cf;color:#2f5d2f;
  padding:.7rem .9rem;border-radius:4px;margin-bottom:1rem}
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

/**
 * The console's three pages, and how you get from one to another.
 *
 * There was no nav at all: /ops/signals existed and nothing on /ops/routing
 * linked to it, so it was reachable only by typing the URL. A page nobody can
 * find is a page nobody reads, which for a triage queue is the same as not
 * having one.
 */
const TABS: readonly (readonly [string, string])[] = Object.freeze([
  ['/ops/routing', 'Routing'],
  ['/ops/users', 'Users'],
  ['/ops/signals', 'Signals'],
]);

function topbar(operator: string): string {
  return `<div class="who">${esc(operator)} ·
  <form method="post" action="/ops/logout"><button type="submit">sign out</button></form></div>`;
}

function tabs(current: string): string {
  return `<nav class="tabs">${TABS.map(([href, label]) =>
    `<a href="${href}"${href === current ? ' class="on"' : ''}>${label}</a>`).join('')}</nav>`;
}

/**
 * Something broke and the operator is signed in.
 *
 * The message is written HERE, never taken from the error — `/ops/signals`
 * already learned that lesson the expensive way: `promote()` throws
 * "below the k-anonymity floor: 7 of 25 sessions", and echoing it handed a
 * browser the exact number the floor exists to withhold.
 */
export function errorPage(operator: string, current: string, message: string): string {
  return shell('Error', `
${topbar(operator)}
<h1>Something went wrong</h1>
<p class="sub">It is in the log rather than on this page.</p>
${tabs(current)}
<div class="err">${esc(message)}</div>`);
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
${topbar(v.operator)}
<h1>Routing</h1>
<p class="sub">Which model answers which turn. Clearance is checked separately,
per child, and can still refuse a cell chosen here.</p>
${tabs('/ops/routing')}

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
${topbar(v.operator)}
<h1>Signals</h1>
<p class="sub">Shapes the pipeline handled badly, and the examples authored to fix them.
A shape appears here only once <strong>25 distinct sessions</strong> have produced it —
below that there is no shape stored to show.</p>
${tabs('/ops/signals')}

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

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Families — named, counted, editable.
 *
 * WHAT IS NOT HERE, and the list is the point. No transcript, no memory fact,
 * no flag note, no message body, no PIN. The console can tell an operator that
 * a child sent forty turns and cannot tell them one word of any of them.
 *
 * NO ID EVER GOES IN A URL. `req.url` is logged next to the caller's address
 * (apps/api/src/logging.ts), so an id in a query string is an id in a log file
 * — the rule /ops/signals already follows. The page number is the only thing in
 * the query string and a page number is not a subject; every edit and every
 * erase puts its id in a POST BODY.
 *
 * NO SEARCH BOX, still. Not a privacy fig leaf now that names render — a
 * practical one: `email_hash` is a blind index, and a box that resolves an
 * address to a family is an oracle for testing guessed addresses. Pagination
 * reads a page; that is the whole interface.
 *
 * THE FORMS ARE PLAIN HTML, and the destructive one is deliberately awkward:
 * erase needs the child's handle typed back. There is no client JavaScript on
 * this console to put up a confirm dialog, and "are you sure" as a second
 * button is one mis-click away from a crypto-shred.
 */

/** Two-word relative time. An operator scanning a column wants "3d", not a date. */
function ago(then: Date | null, now: number): string {
  if (then === null) return '<span style="color:var(--dim)">never</span>';
  const mins = Math.max(0, Math.round((now - then.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Zero is real information on this page; it should not shout. */
function n(value: number): string {
  return value === 0 ? '<span style="color:var(--dim)">0</span>' : String(value);
}

function tile(label: string, value: number, warn = false): string {
  return `<div class="tile${warn && value > 0 ? ' warn' : ''}">
    <b>${value}</b><span>${esc(label)}</span></div>`;
}

/** Unreadable is not the same as blank, and the page should say which. */
function shown(value: string | null, why = 'key shredded'): string {
  return value === null
    ? `<span style="color:var(--dim)" title="${esc(why)}">—</span>`
    : esc(value);
}

export interface UsersPageView {
  readonly operator: string;
  readonly view: UsersView;
  readonly actions: readonly OpsActionRow[];
  readonly error?: string | undefined;
  readonly notice?: string | undefined;
  /** Injected so the rendered "3d ago" column is testable. */
  readonly now?: number;
}

export function usersPage(v: UsersPageView): string {
  const { totals, parents, page, pageCount } = v.view;
  const now = v.now ?? Date.now();
  /**
   * The page to come back to after a POST, carried in the BODY.
   *
   * The first draft of this opened an edit form with `?edit=child:<uuid>`, which
   * would have put a child id in a URL — and `req.url` is logged unredacted next
   * to the caller's address. `<details>` does the same job in the browser with
   * no state in the URL at all, and no JavaScript: the console still ships none.
   */
  const back = `<input type="hidden" name="page" value="${page}">`;

  const tiles = [
    tile('families', totals.parents),
    tile('children', totals.children),
    tile('consent active', totals.consentActive),
    tile('awaiting proof', totals.consentPending),
    tile('revoked', totals.consentRevoked),
    tile('sessions', totals.sessions),
    tile('turns', totals.messages),
    tile('active 24h', totals.activeToday),
    tile('spine turns', totals.spine),
    tile('crisis locks', totals.crisisLocks, true),
    tile('locks still on', totals.locksOpen, true),
    tile('flags open', totals.flagsOpen, true),
    tile('memories', totals.memories),
    tile('live now', totals.sessionsLive),
  ].join('');

  const COLS = 9;

  /** The parent's own edit form, collapsed until an operator opens it. */
  const parentForm = (p: UsersView['parents'][number]): string => `
    <tr class="edit"><td colspan="${COLS}">
      <details><summary>Edit family ${esc(handle(p.id))}</summary>
      <form method="post" action="/ops/users/parent">
        <input type="hidden" name="parent_id" value="${esc(p.id)}">${back}
        <div class="row">
          <div><label for="pn-${esc(handle(p.id))}">Parent name</label>
            <input id="pn-${esc(handle(p.id))}" name="name" type="text"
              value="${esc(p.name ?? '')}"></div>
          <div><label for="pe-${esc(handle(p.id))}">Email</label>
            <input id="pe-${esc(handle(p.id))}" name="email" type="text"
              value="${esc(p.email ?? '')}"></div>
          <div style="flex:0 0 7rem"><label for="pl-${esc(handle(p.id))}">Locale</label>
            <input id="pl-${esc(handle(p.id))}" name="locale" type="text"
              value="${esc(p.locale)}"></div>
        </div>
        <label for="pr-${esc(handle(p.id))}">Reason</label>
        <input id="pr-${esc(handle(p.id))}" name="reason" type="text"
          placeholder="why this change, in a sentence someone reading an incident review would want">
        <button type="submit">Save</button>
        <p class="note">Recorded against <strong>${esc(v.operator)}</strong>. The email is
        also a blind index, so both move together — an address changed in one place
        and not the other makes a parent unfindable by their own email.</p>
      </form></details></td></tr>`;

  /** A child's edit form, plus the erase form beneath it. */
  const childForm = (c: UsersView['parents'][number]['children'][number]): string => {
    const h = esc(handle(c.id));
    return `
    <tr class="edit"><td colspan="${COLS}">
      <details><summary>Edit or erase child ${h}</summary>
      <form method="post" action="/ops/users/child">
        <input type="hidden" name="child_id" value="${esc(c.id)}">${back}
        <div class="row">
          <div><label for="cn-${h}">Child first name</label>
            <input id="cn-${h}" name="first_name" type="text" value="${esc(c.firstName ?? '')}"></div>
          <div><label for="cb-${h}">Band</label>
            <select id="cb-${h}" name="band">${options([...BANDS], c.band)}</select></div>
          <div><label for="cd-${h}">Board</label>
            <input id="cd-${h}" name="board" type="text" value="${esc(c.board)}"></div>
        </div>
        <label for="cr-${h}">Reason</label>
        <input id="cr-${h}" name="reason" type="text"
          placeholder="why this change, in a sentence someone reading an incident review would want">
        <button type="submit">Save</button>
        <p class="note">Saving writes a NEW consent version that supersedes the current
        one — the name, the band and the board are all covered by the record's seal, so
        a correction has to be re-sealed rather than edited in place. The family stays
        signed in; the bearer token moves to the new version in the same transaction.
        Country is not editable here: the law a consent was granted under is chosen from
        it, so moving a family between jurisdictions is a re-consent, not a correction.</p>
      </form>

      <form method="post" action="/ops/users/erase" class="danger">
        <input type="hidden" name="child_id" value="${esc(c.id)}">${back}
        <strong>Erase this child</strong>
        <p class="note">Shreds the encryption key and drops every message, memory and
        flag. There is no undo: the key is gone, so the ciphertext is gone with it. The
        consent ledger stays, as proof a consent existed and was withdrawn. Normally
        this is a parent's decision behind their own PIN.</p>
        <div class="row">
          <div><label for="ec-${h}">Type <code>${h}</code> to confirm</label>
            <input id="ec-${h}" name="confirm" type="text" autocomplete="off"></div>
          <div><label for="er-${h}">Reason</label>
            <input id="er-${h}" name="reason" type="text"
              placeholder="who asked, and how you know it was them"></div>
        </div>
        <button type="submit" class="warn">Erase permanently</button>
      </form>
      </details></td></tr>`;
  };

  const rows = parents.length === 0
    ? `<tr><td colspan="${COLS}" class="note">No families yet.</td></tr>`
    : parents.map((p) => {
      const kids = p.children.length;
      const fam = `<tr class="fam">
        <td class="mono"><strong>${esc(handle(p.id))}</strong>${
  p.erased ? ' <span class="tag default">erased</span>' : ''}</td>
        <td><strong>${shown(p.name)}</strong><br>
          <span style="color:var(--dim)">${shown(p.email)}</span></td>
        <td>${kids} ${kids === 1 ? 'child' : 'children'}
          <span class="mono" style="color:var(--dim)">${esc(p.locale)} · ${
  esc(p.createdAt.toISOString().slice(0, 10))}</span></td>
        <td class="num">${n(p.sessions)}</td>
        <td class="num">${n(p.messages)}</td>
        <td class="num">${n(p.memories)}</td>
        <td class="num">${n(p.flagsOpen)}</td>
        <td class="num">${n(p.locks)}</td>
        <td>${ago(p.lastSeen, now)}</td></tr>`;

      const children = p.children.length === 0
        ? `<tr class="kid"><td colspan="${COLS}" class="note">Enrolled, no child record —
             a draft consent that was never completed.</td></tr>`
        : p.children.map((c) => {
          const row = `<tr class="kid">
          <td class="mono" style="color:var(--dim)">↳ ${esc(handle(c.id))}${
  c.erased ? ' <span class="tag default">erased</span>' : ''}</td>
          <td>${shown(c.firstName)}</td>
          <td>${esc(c.band)} · ${esc(c.country)} ·
            <span class="tag${c.consentStatus === 'active' ? '' : ' default'}">${
  esc(c.consentStatus ?? 'none')}</span>
            <span class="mono" style="color:var(--dim)">${esc(c.board)}${
  c.memoryOn === true ? ' · memory' : ''}${c.learnOn === true ? ' · learning' : ''}</span></td>
          <td class="num">${n(c.sessions)}${
  c.live > 0 ? ` <span class="tag">${c.live} live</span>` : ''}</td>
          <td class="num" title="${c.spine} spine turn${c.spine === 1 ? '' : 's'}, ${
  c.readAttempts} reading attempt${c.readAttempts === 1 ? '' : 's'}">${n(c.messages)}</td>
          <td class="num">${n(c.memories)}</td>
          <td class="num" title="${c.flagsTotal} total">${n(c.flagsOpen)}</td>
          <td class="num">${n(c.locks)}</td>
          <td>${ago(c.lastSeen, now)}</td></tr>`;
          // An erased child has a shredded key: there is nothing left to edit,
          // and nothing left to erase.
          return row + (c.erased ? '' : childForm(c));
        }).join('');

      return fam + (p.erased ? '' : parentForm(p)) + children;
    }).join('');

  const log = v.actions.length === 0
    ? '<p class="note">No operator has changed a family yet.</p>'
    : `<table><tr><th>when</th><th>who</th><th>what</th><th>subject</th>
         <th>fields</th><th>why</th></tr>${
  v.actions.map((a) => `<tr>
      <td class="mono" style="white-space:nowrap">${
  esc(a.createdAt.toISOString().slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(a.actor)}</td>
      <td class="mono">${esc(a.action)}</td>
      <td class="mono">${esc(a.subject)} ${esc(handle(a.subjectId))}</td>
      <td class="mono" style="color:var(--dim)">${
  a.fields.length === 0 ? '—' : esc(a.fields.join(', '))}</td>
      <td>${esc(a.reason)}</td></tr>`).join('')}</table>`;

  const pager = pageCount <= 1 ? '' : `<div class="pager">
    ${page > 1 ? `<a href="/ops/users?page=${page - 1}">← newer</a>` : '<span>← newer</span>'}
    <span>page ${page} of ${pageCount}</span>
    ${page < pageCount ? `<a href="/ops/users?page=${page + 1}">older →</a>` : '<span>older →</span>'}
  </div>`;

  return shell('Users', `
${topbar(v.operator)}
<h1>Users</h1>
<p class="sub">Who is using Chittu, how much, and the record of every change made
from here. Newest family first.</p>
${tabs('/ops/users')}

${v.error === undefined ? '' : `<div class="err">${esc(v.error)}</div>`}
${v.notice === undefined ? '' : `<div class="ok">${esc(v.notice)}</div>`}

<div class="tiles">${tiles}</div>

<h2>Families</h2>
<table>
  <tr><th>handle</th><th>who</th><th>details</th><th class="num">sessions</th>
      <th class="num">turns</th><th class="num">memories</th><th class="num">flags</th>
      <th class="num">locks</th><th>last seen</th></tr>
  ${rows}
</table>
${pager}
<p class="note">There is no transcript, no memory fact, no flag note and no message
body anywhere on this page: turn counts come from the session counter, so nothing
here reads a child's messages. There is no search box either — the parent email is
stored as a blind index, and a box that resolves an address to a family is an
oracle for testing guessed addresses. A dash means a value could not be decrypted,
which for a parent means the first child's key has been shredded.</p>

<h2>What operators have changed</h2>
${log}
<p class="note">Append-only, and the actor comes from the signed-in token rather
than from anything typed into a form. It records which fields moved, never what
they became — an audit row holding an old email address would be a copy of the one
adult identifier we hold, in a table with no key to shred.</p>`);
}
