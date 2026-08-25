/**
 * Routing configuration — which model serves which category, without a deploy.
 *
 * `route()` is the single place a vendor is chosen (§12.3). That is what makes
 * routing enforceable, and it is also what makes it dangerous to open up: a
 * config layer over the one choke point is, if you build it carelessly, a way to
 * point every child's turn at an arbitrary model.
 *
 * So this is a SELECTOR, not an injector. Three properties, each tested:
 *
 * 1. **The catalogue is compiled in.** Config chooses among (provider, model)
 *    pairs that exist in this file. It cannot introduce a model string. A typo,
 *    a stale runbook or a compromised database row can pick the wrong reviewed
 *    model; none of them can pick an unreviewed one.
 *
 * 2. **promptVersion is never configurable.** It is derived from the code that
 *    owns the prompt. Otherwise a cell could claim a prompt version it is not
 *    running, and the audit trail would record a lie in the one field a
 *    certifier reads.
 *
 * 3. **Bad config falls back to the compiled default, and says so.** Never to
 *    "whatever was asked for". In production it refuses to start instead —
 *    silently running a different model than the config claims is the §8b
 *    failure mode, and it would be invisible.
 *
 * Clearance is unaffected and still applies AFTER this: `route()` refuses a
 * provider that `provider_clearance` has not cleared for every enabled market.
 * Config can pick a cell; it cannot make an uncleared vendor callable.
 */

import type { RouterCategory } from '@chittu/contracts';
import type { DbPool } from '@chittu/db';
import { CLASSIFIER_PROMPT_VERSION } from '@chittu/safety-kernel';
import { SANDBOX_PROMPT_VERSION } from '@chittu/pedagogy';
import { DEFAULT_CELLS, type CellConfig } from './router.js';

/**
 * Every (provider, model) pair this build may route to.
 *
 * Adding a row is a code change on purpose: a model that serves children should
 * be reviewed in a diff, not typed into a table at 2am. `chittu-local` is absent
 * because it is not deployable yet (§13.2) — when it is, it belongs here first.
 */
export const MODEL_CATALOGUE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze([
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-opus-5',
  ]),
});

export const CATEGORIES: readonly RouterCategory[] = Object.freeze([
  'classifier', 'sandbox', 'homework', 'curriculum', 'vision', 'embedding',
]);

/**
 * The prompt version for a category, from the package that owns the prompt.
 * Not a lookup into config — see property 2 in the header.
 */
export function promptVersionFor(category: RouterCategory): string {
  switch (category) {
    case 'classifier': return CLASSIFIER_PROMPT_VERSION;
    case 'embedding': return DEFAULT_CELLS.embedding.promptVersion;
    default: return SANDBOX_PROMPT_VERSION;
  }
}

export type CellOrigin = 'default' | 'env' | 'db';

/** One row of `provider_cell`. `promptVersion` is deliberately not read. */
export interface CellRow {
  readonly category: string;
  readonly provider: string;
  readonly model: string;
}

export interface ResolvedCells {
  readonly cells: Readonly<Record<RouterCategory, CellConfig>>;
  readonly origin: Readonly<Record<RouterCategory, CellOrigin>>;
  /** Everything rejected, in words. Empty means the config was fully understood. */
  readonly problems: readonly string[];
  /** True when CHITTU_ROUTING_DB=off discarded rows that existed. */
  readonly dbIgnored: boolean;
}

export interface ResolveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly rows?: readonly CellRow[];
  /** Production. Any rejected config throws instead of falling back. */
  readonly strict?: boolean;
}

export class RoutingConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`routing config rejected:\n  ${problems.join('\n  ')}`);
    this.name = 'RoutingConfigError';
  }
}

const ENV_PREFIX = 'CHITTU_CELL_';

function isCategory(x: string): x is RouterCategory {
  return (CATEGORIES as readonly string[]).includes(x);
}

/**
 * Validate one candidate. Returns the cell, or the reason it was refused.
 * `promptVersion` is attached here and comes from code, never from the input.
 */
function validate(
  category: RouterCategory, provider: string, model: string, where: string,
): { cell: CellConfig } | { problem: string } {
  const models = MODEL_CATALOGUE[provider];
  if (models === undefined) {
    return { problem: `${where}: provider ${JSON.stringify(provider)} is not in the catalogue — add it in cells.ts first` };
  }
  if (!models.includes(model)) {
    return { problem: `${where}: model ${JSON.stringify(model)} is not catalogued for ${provider} (have: ${models.join(', ')})` };
  }
  return { cell: { provider, model, promptVersion: promptVersionFor(category) } };
}

/** `provider:model`, or a reason it is not that. */
function parsePair(raw: string, where: string): { provider: string; model: string } | { problem: string } {
  const at = raw.indexOf(':');
  if (at <= 0 || at === raw.length - 1) {
    return { problem: `${where}: expected "provider:model", got ${JSON.stringify(raw)}` };
  }
  return { provider: raw.slice(0, at).trim(), model: raw.slice(at + 1).trim() };
}

export function resolveCells(opts: ResolveOptions = {}): ResolvedCells {
  const env = opts.env ?? {};
  const problems: string[] = [];

  const cells: Record<RouterCategory, CellConfig> = { ...DEFAULT_CELLS };
  const origin: Record<RouterCategory, CellOrigin> = {
    classifier: 'default', sandbox: 'default', homework: 'default',
    curriculum: 'default', vision: 'default', embedding: 'default',
  };

  // ------------------------------------------------------------------ env ---
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || raw === undefined || raw === '') continue;
    const name = key.slice(ENV_PREFIX.length).toLowerCase();
    if (!isCategory(name)) {
      problems.push(`${key}: ${JSON.stringify(name.toUpperCase())} is not a routing category (have: ${CATEGORIES.join(', ')})`);
      continue;
    }
    const pair = parsePair(raw, key);
    if ('problem' in pair) { problems.push(pair.problem); continue; }
    const v = validate(name, pair.provider, pair.model, key);
    if ('problem' in v) { problems.push(v.problem); continue; }
    cells[name] = v.cell;
    origin[name] = 'env';
  }

  // ------------------------------------------------------------------- db ---
  /**
   * DB wins over env, because the entire point of the table is to change
   * routing without a deploy — an env pin that outranked it would make the
   * table decorative. A deployment that wants to be un-overridable sets
   * CHITTU_ROUTING_DB=off, which is explicit and shows up in the startup log.
   */
  const rows = opts.rows ?? [];
  const dbOff = (env['CHITTU_ROUTING_DB'] ?? '').toLowerCase() === 'off';
  const dbIgnored = dbOff && rows.length > 0;

  if (!dbOff) {
    for (const row of rows) {
      const where = `provider_cell(${row.category})`;
      if (!isCategory(row.category)) {
        problems.push(`${where}: not a routing category`);
        continue;
      }
      const v = validate(row.category, row.provider, row.model, where);
      if ('problem' in v) { problems.push(v.problem); continue; }
      cells[row.category] = v.cell;
      origin[row.category] = 'db';
    }
  }

  if (opts.strict === true && problems.length > 0) {
    throw new RoutingConfigError(problems);
  }

  return {
    cells: Object.freeze(cells),
    origin: Object.freeze(origin),
    problems: Object.freeze(problems),
    dbIgnored,
  };
}

/** One line per non-default cell, for the startup log. */
export function describeCells(r: ResolvedCells): string[] {
  const lines = CATEGORIES
    .filter((c) => r.origin[c] !== 'default')
    .map((c) => `  ${c} -> ${r.cells[c].provider}/${r.cells[c].model} (${r.origin[c]})`);
  if (r.dbIgnored) lines.push('  CHITTU_ROUTING_DB=off — provider_cell rows were NOT applied');
  return lines;
}

/**
 * The current cell assignments from `provider_cell` — newest row per category.
 *
 * FAILS SOFT, DELIBERATELY, and this is the same rule the helpline registry
 * follows: the compiled defaults are the floor. An unreachable database, a
 * missing table or an empty result all mean "no override", never "no routing".
 * Routing is on the path of every turn; a database problem must not be able to
 * take the product down, and the fallback is a reviewed constant rather than
 * an absence.
 *
 * Note what is NOT swallowed: a row that names an uncatalogued model is not an
 * error here — it is read fine and rejected by `resolveCells`, loudly, with the
 * offending value quoted. Reading and validating are separate on purpose.
 */
export async function readCells(pool: DbPool): Promise<CellRow[]> {
  try {
    const { rows } = await pool.query<{ category: string; provider: string; model: string }>(
      `SELECT DISTINCT ON (category) category, provider, model
         FROM provider_cell
        ORDER BY category, changed_at DESC, id DESC`);
    return rows.map((r) => ({ category: r.category, provider: r.provider, model: r.model }));
  } catch {
    return [];
  }
}
