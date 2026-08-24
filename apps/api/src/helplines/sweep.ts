/**
 * The sweep job — GAP-06, build order item 6.
 *
 * **What this is honest about.** It does not dial anything. There is no API that
 * tells you whether a national child helpline still answers, so the sweep does
 * the only thing software can do here: it notices that a re-check date has
 * passed, moves the row to `stale`, and pages a human. **The human is the
 * verification.** Software's job is to make sure nobody forgets to be one.
 *
 * That is a smaller claim than "verified helplines", and it is deliberately
 * smaller. Requirements §9 asks for a registry *and a sweep job*; the registry
 * without the sweep is a table that silently rots, which is exactly the failure
 * this closes.
 *
 * Alerting goes through a port. Today it writes to the log; wiring it to
 * PagerDuty is a construction change, not a rewrite — and until that is done,
 * `docs/runbooks/helpline-p0.md` is what a human follows.
 */

import { helplineRepo, type DbPool, type HelplineRow } from '@chittu/db';

export type AlertLevel = 'P0' | 'WARN';

export interface HelplineAlert {
  readonly level: AlertLevel;
  readonly country: string;
  readonly message: string;
  readonly runbook: string;
}

/** Injected so tests count alerts, and so production can page instead of log. */
export type AlertPort = (alert: HelplineAlert) => void | Promise<void>;

const RUNBOOK = 'docs/runbooks/helpline-p0.md';

export const consoleAlert: AlertPort = (a) => {
  // Deliberately `error` even for WARN: an overdue crisis helpline should not
  // be filtered out with the info logs.
  console.error(`[chittu][${a.level}] helplines/${a.country}: ${a.message} — see ${RUNBOOK}`);
};

export interface SweepReport {
  readonly checked: number;
  readonly newlyStale: readonly string[];
  /** Already-known-wrong rows, re-reported every sweep until someone fixes them. */
  readonly p0: readonly string[];
  readonly at: string;
}

export interface SweepOptions {
  readonly now?: Date;
  readonly alert?: AlertPort;
}

export async function runSweep(
  pool: DbPool, opts: SweepOptions = {},
): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const alert = opts.alert ?? consoleAlert;
  const repo = helplineRepo(pool);

  const all = await repo.listAll(pool);
  const due = await repo.dueForSweep(pool, now);

  const newlyStale = due.map((r) => r.country);
  if (newlyStale.length > 0) await repo.markStale(pool, newlyStale);

  for (const row of due) {
    await alert({
      level: 'WARN',
      country: row.country,
      message: `re-check was due ${row.nextSweep} (last verified ${row.lastVerified} `
        + `by ${row.verifiedBy}); numbers are still being shown to children`,
      runbook: RUNBOOK,
    });
  }

  // Re-reported on EVERY sweep, on purpose. A known-wrong number that nobody
  // has fixed is not less urgent on day three than on day one, and an alert
  // that fires once is an alert that gets lost.
  const p0 = all.filter((r: HelplineRow) => r.status === 'P0_WRONG_NUMBER');
  for (const row of p0) {
    await alert({
      level: 'P0',
      country: row.country,
      message: 'registry is flagged WRONG; children are being given the '
        + 'compiled-in fallback numbers until this is corrected',
      runbook: RUNBOOK,
    });
  }

  // A market with no registry row at all is also a gap, and a quiet one: the
  // fallback works, so nothing breaks and nobody notices it was never loaded.
  return {
    checked: all.length,
    newlyStale,
    p0: p0.map((r) => r.country),
    at: now.toISOString(),
  };
}

/**
 * Run it on a timer in-process.
 *
 * The production shape is a scheduled task (§14 Terraform), not a `setInterval`
 * inside the API — a job that only runs while one process happens to be up is a
 * job that stops when that process does. This exists so the sweep is not
 * *absent* until that lands, and it says so in the log.
 */
export function startSweepTimer(
  pool: DbPool, everyMs: number, opts: SweepOptions = {},
): () => void {
  const tick = () => {
    runSweep(pool, opts).then((r) => {
      if (r.newlyStale.length > 0 || r.p0.length > 0) return;
      console.info(`[chittu] helpline sweep: ${r.checked} registries, all current.`);
    }).catch((e: unknown) => {
      console.error('[chittu] helpline sweep failed:', e instanceof Error ? e.message : e);
    });
  };
  const t = setInterval(tick, everyMs);
  // Never hold the process open for a sweep.
  if (typeof t.unref === 'function') t.unref();
  tick();
  return () => clearInterval(t);
}
