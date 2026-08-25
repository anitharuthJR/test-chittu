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
