import { buildServer } from './server.js';
import { stubRouter } from './providers.js';
import { anthropicAdapter } from './providers/anthropic.js';
import { localAdapter } from './providers/local.js';
import { createRouter } from './providers/router.js';
import { readClearance, enabledMarkets } from './providers/clearance.js';
import { CATEGORIES, readCells, resolveCells, describeCells } from './providers/cells.js';
import { bootstrapDb } from './db-bootstrap.js';
import { resolveKeys } from './keys/index.js';
import { startSweepTimer } from './helplines/sweep.js';
import { buildLoggerOptions, resolveLogDir } from './logging.js';
import { loadEnvLocal } from './env-local.js';

/**
 * FIRST, before anything reads process.env. A no-op in production and whenever
 * the file is absent; it never overrides a variable the shell already set.
 *
 * Names are echoed and values are not — this line is the only evidence that a
 * file, rather than the shell, is why the router has a key.
 */
const fromFile = loadEnvLocal();
if (fromFile.length > 0) {
  console.warn(`[chittu] .env.local supplied: ${fromFile.join(', ')}`);
}

const port = Number(process.env['PORT'] ?? 8080);
const isProd = process.env['NODE_ENV'] === 'production';
const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
/**
 * The self-hosted lane — an OpenAI-compatible endpoint (Ollama, mlx_lm, vLLM).
 * Absent by default: a deployment opts in by naming a URL, and a laptop that
 * has not started one is not a broken deployment.
 */
const localUrl = process.env['CHITTU_LOCAL_BASE_URL'] ?? '';

/**
 * Config first, connections second.
 *
 * This check sits above `bootstrapDb()` deliberately: in production the
 * database is also required, so leaving it below meant the missing-key refusal
 * was shadowed by a missing-DATABASE_URL error and never seen. Refuse on the
 * cheapest, most specific thing first.
 */
/**
 * NO PROVIDER AT ALL is the refusal, not "no Anthropic key".
 *
 * This read `apiKey === ''` while there was one provider, and it would have
 * been wrong the moment there were two: a deployment running the self-hosted
 * lane alone would have been refused for missing a key it does not use.
 */
if (isProd && apiKey === '' && localUrl === '') {
  throw new Error(
    'refusing to start: no provider is configured. Set ANTHROPIC_API_KEY or '
    + 'CHITTU_LOCAL_BASE_URL — with neither, the only available router is the '
    + 'stub, and the stub classifies every turn SAFE.',
  );
}

/**
 * The key provider, resolved as CONFIG — above the database, like the check
 * above it.
 *
 * Outside dev this refuses unless a KMS CMK is configured. That refusal is the
 * point: the alternative, which is what shipped before, is a local provider
 * holding an EPHEMERAL master key — different in every task, discarded on
 * restart — under which a child's name is written once and readable by nobody,
 * including the task that wrote it after it restarts.
 */
const keys = resolveKeys();

const { pool } = await bootstrapDb();
// The host and database, never the credentials — this line goes to stdout and
// into api.log, and DATABASE_URL carries a password.
{
  const u = new URL(process.env['DATABASE_URL']!);
  console.log(`[chittu] database: ${u.host}${u.pathname} — Postgres 16 + pgvector`);
}

/**
 * Choosing a router is the last place a safety decision gets made before the
 * service is answering children, so all three refusals live here and none of
 * them degrade quietly.
 *
 * The stub classifies every turn SAFE. Running it in production would mean L2
 * inspects nothing while the trace still says L2_CLASSIFIER ran — a lie in the
 * one record a certifier reads.
 */
async function chooseRouter() {
  /**
   * Cell assignment is resolved and VALIDATED FIRST — before the stub check,
   * before clearance, before any turn.
   *
   * Validating early is the point. If this sat below the stub branch, a typo in
   * CHITTU_CELL_* would be silently unexamined on every laptop and every CI run,
   * and would first be discovered in production — which is the failure shape
   * this repository keeps finding. So the config is always checked and always
   * reported; whether it is APPLIED depends on whether a real router is built.
   *
   * `strict` in production: a rejected cell there means the deployment believes
   * it is running one model and is running another. That is invisible, and
   * invisible is the part that matters.
   */
  const resolved = resolveCells({
    env: process.env,
    rows: await readCells(pool),
    strict: isProd,
  });
  for (const problem of resolved.problems) {
    console.warn(`[chittu] routing config REJECTED: ${problem}`);
  }
  const overrides = describeCells(resolved);
  const cells = resolved.cells;

  if (apiKey === '' && localUrl === '') {
    if (isProd) {
      throw new Error(
        'refusing to start: no provider is configured. Set ANTHROPIC_API_KEY or '
        + 'CHITTU_LOCAL_BASE_URL — with neither, the only available router is '
        + 'the stub, and the stub classifies every turn SAFE.',
      );
    }
    console.warn(
      '[chittu] no ANTHROPIC_API_KEY and no CHITTU_LOCAL_BASE_URL — using the '
      + 'offline stub router. Every turn classifies SAFE and the sandbox echoes '
      + 'a fixed reply.',
    );
    if (overrides.length > 0) {
      // Checked above, and deliberately NOT described as being in effect: the
      // stub routes nowhere, so saying "sandbox -> claude-opus-5" here would be
      // a false statement about what is running.
      console.warn(
        `[chittu] routing config parsed OK but is NOT in effect (stub router):\n${overrides.join('\n')}`);
    }
    return stubRouter();
  }

  /**
   * Only the providers this deployment can actually reach.
   *
   * A cell pointing at a provider with no adapter is refused by `route()` —
   * `RouteRefused`, which the pipeline turns into an honest degraded turn — so
   * an absent adapter fails loudly rather than falling back to a cleared cell.
   * The boot log below says which are present, because "routing overrides IN
   * EFFECT" is a statement about config and not about capability.
   */
  const adapters: Record<string, ReturnType<typeof anthropicAdapter>> = {};
  if (apiKey !== '') adapters['anthropic'] = anthropicAdapter({ apiKey });
  if (localUrl !== '') {
    adapters['local'] = localAdapter({
      baseUrl: localUrl,
      ...(process.env['CHITTU_LOCAL_API_KEY']
        ? { apiKey: process.env['CHITTU_LOCAL_API_KEY'] } : {}),
    });
    console.warn(
      `[chittu] self-hosted provider available at ${localUrl}. Being reachable `
      + 'is not being promoted: a cell still has to name it, and '
      + 'provider_clearance still has to clear it.');
  }
  console.warn(`[chittu] providers configured: ${Object.keys(adapters).join(', ')}`);

  /**
   * A CELL NAMING A PROVIDER THIS DEPLOYMENT CANNOT REACH is a boot-time
   * refusal in production, not a per-turn surprise. Without it the config log
   * says "overrides IN EFFECT" — true of the config, false of the capability —
   * and every turn falls back with a trace nobody is reading.
   */
  /**
   * `embedding` IS EXCLUDED, and the exclusion is the point rather than an
   * exemption.
   *
   * Every other category is load-bearing: a deployment that cannot reach its
   * classifier or its sandbox cannot serve a child at all, so refusing to boot
   * is the correct, loud outcome. The grounded corpus is an ENRICHMENT — an
   * unreachable embedding cell means answers come from the truth wall instead
   * of from a verified fact, which is exactly the behaviour the product has
   * when the corpus is empty.
   *
   * Including it would refuse to start every deployment that runs Anthropic
   * alone, which is all of them today: `DEFAULT_CELLS.embedding` names `local`,
   * because Anthropic has no embeddings API to name.
   *
   * The absence is not silent — `buildServer` wires no grounding port, the
   * pipeline stamps no CORPUS layer, and the banner below says so at boot.
   */
  const unreachable = CATEGORIES
    .filter((c) => c !== 'embedding')
    .map((c) => ({ category: c, provider: resolved.cells[c].provider }))
    .filter((x) => adapters[x.provider] === undefined);
  if (unreachable.length > 0) {
    const detail = unreachable.map((x) => `${x.category} -> ${x.provider}`).join(', ');
    if (isProd) {
      throw new Error(
        `refusing to start: routing names providers this deployment cannot reach `
        + `(${detail}). Configure them, or point the cells somewhere reachable.`);
    }
    console.warn(`[chittu] cells name unreachable providers: ${detail}`);
  }

  // The positive counterpart to the stub warning above. dev.sh used to print
  // this by inspecting its own shell, which .env.local made unreliable; the
  // process that actually built the router is the only honest place for it.
  console.warn('[chittu] model router: Anthropic — the real L2 classifier runs on every turn.');

  console.warn(overrides.length === 0
    ? '[chittu] routing: all cells at compiled defaults'
    : `[chittu] routing overrides IN EFFECT:\n${overrides.join('\n')}`);

  if (!isProd) {
    // Outside production, clearance is not enforced: there are no signed terms
    // to check against on a laptop, and requiring a seeded table to run `pnpm
    // dev` would only teach people to seed it meaninglessly.
    console.warn('[chittu] provider clearance is NOT enforced outside production.');
    return createRouter({ adapters, cells, scopedCells: resolved });
  }

  const markets = await enabledMarkets(pool);
  const { cleared, partial, byCountry } = await readClearance(pool, markets);
  if (cleared.size === 0) {
    throw new Error(
      `refusing to start: no provider is cleared for every enabled market `
      + `[${markets.join(', ') || 'none enabled'}]. provider_clearance is the `
      + `Seat 10 switch, and an empty result means the review has not happened.`,
    );
  }
  for (const [provider, missing] of Object.entries(partial)) {
    console.warn(
      `[chittu] ${provider} is NOT cleared for ${missing.join(', ')} — not routable.`);
  }
  return createRouter({
    adapters, cells, cleared, scopedCells: resolved, clearedByCountry: byCountry,
  });
}

/**
 * The helpline sweep (GAP-06). Hourly is far more often than a 30-day re-check
 * needs, and that is the point: the cost is one query, and the alternative is a
 * job that only notices at the end of whatever interval it happened to pick.
 *
 * In-process, and that is a stopgap the log admits to. A job that runs only
 * while one API process is up is a job that stops when that process does; the
 * production shape is a scheduled task (§14).
 */
const stopSweep = startSweepTimer(pool, 60 * 60_000);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, stopSweep);

/**
 * Logging destination, announced rather than assumed — "where are the logs" had
 * no answer before this, and the honest one is not the same in every mode.
 *
 * The redaction that comes with it is the point (§2.2: message bodies never
 * enter a log line). In production `LOG_DIR` is unset, stdout is the transport,
 * and §14's log group carries the same filter.
 */
const logDir = resolveLogDir();
const loggerOptions = buildLoggerOptions({ dir: logDir });
console.warn(
  logDir === null
    ? '[chittu] logs -> stdout only (set LOG_DIR to also write a file)'
    : `[chittu] logs -> stdout and ${logDir}/api.log (message bodies redacted)`,
);

/**
 * The ops console is opt-in, per deployment, and absent otherwise.
 *
 * `CHITTU_OPS_TOKENS="name=token,..."`. With none configured the /ops routes are
 * not registered at all — 404, not 403 — because a login form on a deployment
 * that never meant to have a console is pure attack surface.
 */
const opsTokens = process.env['CHITTU_OPS_TOKENS'] ?? '';
console.warn(opsTokens === ''
  ? '[chittu] ops console: NOT mounted (set CHITTU_OPS_TOKENS to enable)'
  : `[chittu] ops console: /ops, ${opsTokens.split(',').length} operator(s)`);

const router = await chooseRouter();

/**
 * Whether the grounded corpus is live, decided by ROUTING rather than by an
 * environment variable.
 *
 * `buildServer` derives the embedder from the router, so the question is
 * whether the `embedding` cell resolves to a provider that is cleared,
 * reachable AND capable of embedding. Asking `route()` is how we find out, and
 * asking it here means the answer is on the boot log rather than inferred from
 * traces a week later.
 *
 * No country in hand at boot, so this gets the conservative clearance rule —
 * cleared for every enabled market. That is the right check for a banner: it
 * says the corpus is on only where it is on everywhere.
 */
{
  let status: string;
  try {
    const d = router.route('embedding');
    status = `ON — ${d.provider}/${d.model}`;
  } catch (e) {
    status = `OFF — ${e instanceof Error ? e.message : String(e)}`;
  }
  console.warn(`[chittu] grounded corpus: ${status}`);
  if (status.startsWith('OFF')) {
    console.warn(
      '[chittu]   no CORPUS layer will be stamped, and answers fall back to the '
      + 'truth wall. Set CHITTU_LOCAL_BASE_URL and clear the provider to enable.');
  }
}

const app = await buildServer({
  pool, keys, router, logger: loggerOptions,
  ...(isProd ? { env: 'prod' as const } : {}),
  ...(opsTokens === '' ? {} : { opsTokens }),
});
/**
 * Bind address. Defaults to loopback and must be opted OUT of.
 *
 * A container needs 0.0.0.0 or nothing outside it can reach the service, but
 * making that the default would silently publish a developer's API — with its
 * local database and, if they exported one, their provider key — to every
 * device on whatever café wifi they are on. So the Dockerfile sets HOST
 * explicitly and a laptop stays on loopback.
 */
const host = process.env['HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
