/**
 * `.env.local` — the laptop's credential file, and nowhere else's.
 *
 * There is no `dotenv` dependency here on purpose: Node cannot take `--env-file`
 * through NODE_OPTIONS ("not allowed in NODE_OPTIONS"), and `pnpm start` reaches
 * node through tsx through pnpm, so there is no command line to put it on. Forty
 * lines in-process is the honest answer.
 *
 * TWO RULES, both of which exist because the alternative fails silently:
 *
 * 1. NEVER IN PRODUCTION. The image sets NODE_ENV=production and `.dockerignore`
 *    already excludes `.env*`, so this is the second wall rather than the first
 *    — but a loader that would read a credential file if one appeared is exactly
 *    the thing that makes baking one into an image a single mistake instead of
 *    two.
 *
 * 2. NEVER OVERRIDE THE ENVIRONMENT. `ANTHROPIC_API_KEY=… pnpm start` must keep
 *    meaning what it says. A file that wins over the shell makes the router and
 *    the operator disagree about which key is in play, and nothing in the output
 *    would show it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The repo root's `.env.local`, resolved from this module rather than the cwd.
 *
 * `pnpm start` runs from the root and `pnpm --filter @chittu/api dev` runs from
 * apps/api, so a cwd-relative path would find the file in one and silently miss
 * it in the other — which presents as "my key does not work". Same `../../../`
 * depth as `applyMigrations` uses for db/migrations, and it holds in `dist/` for
 * the same reason: src/ and dist/ sit at equal depth under apps/api.
 */
export function envLocalPath(): string {
  return fileURLToPath(new URL('../../../.env.local', import.meta.url));
}

export interface LoadEnvLocalOptions {
  /** Defaults to `.env.local` at the repo root — see `envLocalPath`. */
  readonly file?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Strip one matched pair of surrounding quotes, else trim. */
function readValue(raw: string): string {
  const v = raw.trim();
  const quoted = v.length >= 2
    && (v[0] === '"' || v[0] === "'")
    && v[v.length - 1] === v[0];
  // Quoted values are taken literally, so a deliberate leading space survives;
  // unquoted ones are trimmed, because a trailing space on a pasted API key
  // produces a 401 that reads as "bad key" rather than "bad paste".
  return quoted ? v.slice(1, -1) : v;
}

/**
 * Load `.env.local` into `env`, and return the NAMES it set.
 *
 * Names, not values — the caller logs this, and a loader that handed back values
 * would put a provider key in the terminal.
 */
export function loadEnvLocal(opts: LoadEnvLocalOptions = {}): string[] {
  const { file = envLocalPath(), env = process.env } = opts;
  if (env['NODE_ENV'] === 'production') return [];

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Absent is the normal case, not an error.
    return [];
  }

  const set: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;   // not KEY=VALUE; ignore rather than throw

    // `export FOO=bar` is what people paste out of a shell.
    const name = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (name === '') continue;

    // The shell wins — see rule 2.
    if (env[name] !== undefined) continue;

    env[name] = readValue(trimmed.slice(eq + 1));
    set.push(name);
  }
  return set;
}
