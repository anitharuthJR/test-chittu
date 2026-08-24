import { buildServer } from './server.js';
import { stubRouter } from './providers.js';
import { anthropicAdapter } from './providers/anthropic.js';
import { createRouter } from './providers/router.js';
import { readClearance, enabledMarkets } from './providers/clearance.js';
import { bootstrapDb } from './db-bootstrap.js';
import { startSweepTimer } from './helplines/sweep.js';
import { buildLoggerOptions, resolveLogDir } from './logging.js';

const port = Number(process.env['PORT'] ?? 8080);
const isProd = process.env['NODE_ENV'] === 'production';
const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';

/**
 * Config first, connections second.
 *
 * This check sits above `bootstrapDb()` deliberately: in production the
 * database is also required, so leaving it below meant the missing-key refusal
 * was shadowed by a missing-DATABASE_URL error and never seen. Refuse on the
 * cheapest, most specific thing first.
 */
if (isProd && apiKey === '') {
  throw new Error(
    'refusing to start: ANTHROPIC_API_KEY is not set, so the only available '
    + 'router is the stub — and the stub classifies every turn SAFE.',
  );
}

const { pool, keys, driver } = await bootstrapDb();
if (driver === 'pglite') {
  console.warn(
    '[chittu] no DATABASE_URL — using an in-process PGlite database. '
    + 'Real Postgres, but it vanishes when this process exits.',
  );
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
  if (apiKey === '') {
    if (isProd) {
      throw new Error(
        'refusing to start: ANTHROPIC_API_KEY is not set, so the only available '
        + 'router is the stub — and the stub classifies every turn SAFE.',
      );
    }
    console.warn(
      '[chittu] no ANTHROPIC_API_KEY — using the offline stub router. '
      + 'Every turn classifies SAFE and the sandbox echoes a fixed reply.',
    );
    return stubRouter();
  }

  const adapters = { anthropic: anthropicAdapter({ apiKey }) };

  if (!isProd) {
    // Outside production, clearance is not enforced: there are no signed terms
    // to check against on a laptop, and requiring a seeded table to run `pnpm
    // dev` would only teach people to seed it meaninglessly.
    console.warn('[chittu] provider clearance is NOT enforced outside production.');
    return createRouter({ adapters });
  }

  const markets = await enabledMarkets(pool);
  const { cleared, partial } = await readClearance(pool, markets);
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
  return createRouter({ adapters, cleared });
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

const app = await buildServer({
  pool, keys, router: await chooseRouter(), logger: loggerOptions,
  ...(isProd ? { env: 'prod' as const } : {}),
});
/**
 * Bind address. Defaults to loopback and must be opted OUT of.
 *
 * A container needs 0.0.0.0 or nothing outside it can reach the service, but
 * making that the default would silently publish a developer's API — with its
 * PGlite database and, if they exported one, their provider key — to every
 * device on whatever café wifi they are on. So the Dockerfile sets HOST
 * explicitly and a laptop stays on loopback.
 */
const host = process.env['HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
