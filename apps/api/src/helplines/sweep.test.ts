/**
 * The sweep, and the resolution rule it feeds.
 *
 * The question every test here is really asking: **what does a child in crisis
 * get?** Staleness is an operational problem and must never become a
 * content one; a known-wrong number is the reverse, and is the only state
 * allowed to change the script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, helplineRepo, type DbPool } from '@chittu/db';
import { REGISTRY } from '@chittu/safety-kernel';
import { runSweep, type HelplineAlert } from './sweep.js';
import { resolveHelplines } from './resolve.js';

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let pool: DbPool;
let alerts: HelplineAlert[];
const alert = (a: HelplineAlert) => { alerts.push(a); };

const LINES = [
  { name: 'Childline', number: '1098', hours: 'free · 24/7' },
  { name: 'KIRAN', number: '1800-599-0019' },
];

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeEach(async () => {
  fixture = await createTestDb();
  pool = fixture.pool;
  alerts = [];
}, 180_000);

afterEach(async () => { await fixture.close(); });

const seed = (country: string, nextSweep: Date, by = 'ops@tulifo.ai') =>
  helplineRepo(pool).upsert(pool, country, LINES, by, nextSweep);

// ---------------------------------------------------------------------------

describe('the sweep', () => {
  it('does nothing to a registry that is still current', async () => {
    await seed('IN', days(30));
    const r = await runSweep(pool, { alert });
    expect(r.checked).toBe(1);
    expect(r.newlyStale).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('marks an overdue registry stale and pages a human', async () => {
    await seed('IN', days(-1));
    const r = await runSweep(pool, { alert });

    expect(r.newlyStale).toEqual(['IN']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.level).toBe('WARN');
    expect(alerts[0]!.country).toBe('IN');
    // The alert has to say the numbers are STILL BEING SHOWN, or whoever reads
    // it at 2am will assume the system already stopped serving them.
    expect(alerts[0]!.message).toMatch(/still being shown to children/);
    expect(alerts[0]!.runbook).toMatch(/runbooks\/helpline-p0/);

    expect((await helplineRepo(pool).get(pool, 'IN'))!.status).toBe('stale');
  });

  it('does not re-alert an already-stale registry every hour', async () => {
    await seed('IN', days(-1));
    await runSweep(pool, { alert });
    alerts = [];
    await runSweep(pool, { alert });
    expect(alerts, 'stale is reported once, not hourly forever').toEqual([]);
  });

  it('RE-alerts a P0 on every sweep, deliberately', async () => {
    // A known-wrong number is not less urgent on day three than on day one,
    // and an alert that fires once is an alert that gets lost.
    await seed('IN', days(30));
    await helplineRepo(pool).flagP0(pool, 'IN', 'ops@tulifo.ai');

    for (let i = 0; i < 3; i++) {
      alerts = [];
      const r = await runSweep(pool, { alert });
      expect(r.p0).toEqual(['IN']);
      expect(alerts.filter((a) => a.level === 'P0')).toHaveLength(1);
    }
  });

  it('does not sweep a P0 row back into staleness', async () => {
    await seed('IN', days(-1));
    await helplineRepo(pool).flagP0(pool, 'IN', 'ops@tulifo.ai');
    await runSweep(pool, { alert });
    expect((await helplineRepo(pool).get(pool, 'IN'))!.status).toBe('P0_WRONG_NUMBER');
  });

  it('clears back to verified when a human re-checks', async () => {
    await seed('IN', days(-1));
    await runSweep(pool, { alert });
    await helplineRepo(pool).markVerified(pool, 'IN', 'seat-12@tulifo.ai', days(30));

    const row = (await helplineRepo(pool).get(pool, 'IN'))!;
    expect(row.status).toBe('verified');
    // The schema requires an attributed verifier, because an unattributed
    // verification is not a verification.
    expect(row.verifiedBy).toBe('seat-12@tulifo.ai');

    alerts = [];
    expect((await runSweep(pool, { alert })).newlyStale).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('reports every market it checked, so a missing registry is visible', async () => {
    await seed('IN', days(30));
    await seed('US', days(30));
    expect((await runSweep(pool, { alert })).checked).toBe(2);
  });
});

describe('what a child actually gets', () => {
  it('serves the live registry when it is verified', async () => {
    await seed('IN', days(30));
    const r = await resolveHelplines(pool, 'IN');
    expect(r.source).toBe('registry');
    expect(r.status).toBe('verified');
    expect(r.text).toBe('Childline 1098 · free · 24/7 · KIRAN 1800-599-0019');
  });

  it('STILL serves a stale registry — overdue is not wrong', async () => {
    // The most important test in this file. Withholding a probably-correct
    // helpline from a child in crisis because OUR re-check date slipped would
    // punish the child for our process failure, and a missing number is worse
    // than an unverified one.
    await seed('IN', days(-1));
    await runSweep(pool, { alert });

    const r = await resolveHelplines(pool, 'IN');
    expect(r.status).toBe('stale');
    expect(r.source).toBe('registry');
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/1098/);
  });

  it('falls back to the shipped numbers when the registry is flagged WRONG', async () => {
    // The one state that changes the script: a number known to be wrong is
    // worse than no number, because a child dials it and nobody answers.
    await seed('IN', days(30));
    await helplineRepo(pool).upsert(
      pool, 'IN', [{ name: 'Disconnected', number: '000-000' }], 'ops', days(30));
    await helplineRepo(pool).flagP0(pool, 'IN', 'ops@tulifo.ai');

    const r = await resolveHelplines(pool, 'IN');
    expect(r.source).toBe('builtin');
    expect(r.text).not.toMatch(/000-000/);
    expect(r.text).toBe(REGISTRY.IN.lines.map((l) => `${l.name} ${l.contact}`).join(' · '));
  });

  it('falls back when no registry row has been loaded at all', async () => {
    const r = await resolveHelplines(pool, 'GB');
    expect(r.source).toBe('builtin');
    expect(r.lines).toEqual(REGISTRY.GB.lines);
  });

  it('falls back when the DATABASE is unreachable', async () => {
    // The registry is an overlay, never a dependency. A child in crisis does
    // not wait on a query, and does not get an empty panel if one fails.
    const broken = {
      query: () => Promise.reject(new Error('connection refused')),
    } as unknown as DbPool;
    const r = await resolveHelplines(broken, 'IN');
    expect(r.source).toBe('builtin');
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it('falls back when a row exists but carries no lines', async () => {
    // The schema forbids an empty array, so this shape can only arrive from a
    // future migration or a bad backfill — which is exactly why the code checks
    // rather than trusting. An empty crisis panel is the one outcome worth two
    // guards.
    const emptyRow = {
      query: () => Promise.resolve({ rows: [{
        country: 'IN', lines: [], status: 'verified',
        last_verified: new Date().toISOString(), verified_by: 'ops',
        next_sweep: new Date().toISOString(),
      }] }),
    } as unknown as DbPool;

    const r = await resolveHelplines(emptyRow, 'IN');
    expect(r.source).toBe('builtin');
    expect(r.lines.length).toBeGreaterThan(0);
  });
});

describe('the schema refuses what the code should never write', () => {
  it('will not store a registry with no lines', async () => {
    await expect(pool.query(
      `INSERT INTO helpline_registry (country, lines, last_verified, verified_by, next_sweep)
       VALUES ('IN','[]'::jsonb, now(), 'ops', now() + interval '30 days')`))
      .rejects.toThrow();
  });

  it('will not enable a market with no helplines at all', async () => {
    // Fired unprompted during verification: the trigger exists so a market
    // cannot go live with an empty crisis script.
    await expect(pool.query(`INSERT INTO market (country, enabled) VALUES ('US', true)`))
      .rejects.toThrow(/verified helplines/i);
  });
});

describe('GB and UK are the same market', () => {
  /**
   * The bug this pins broke the very first import and would have been silent
   * afterwards: `'GB'::jurisdiction` raises, `resolveHelplines` catches, and
   * every British child runs on the compiled-in numbers forever with nothing to
   * see but a log line.
   */
  it('stores, reads and corrects a GB registry', async () => {
    await helplineRepo(pool).upsert(
      pool, 'GB', [{ name: 'Childline UK', number: '0800 1111' }],
      'ops@tulifo.ai', days(30));

    const r = await resolveHelplines(pool, 'GB');
    expect(r.source, 'a GB lookup must reach the UK row').toBe('registry');
    expect(r.text).toMatch(/0800 1111/);
  });

  it('flags and sweeps GB without ever seeing a GB enum value', async () => {
    await helplineRepo(pool).upsert(
      pool, 'GB', [{ name: 'Childline UK', number: '0800 1111' }],
      'ops@tulifo.ai', days(-1));

    const swept = await runSweep(pool, { alert });
    expect(swept.newlyStale).toEqual(['UK']);
    expect((await resolveHelplines(pool, 'GB')).status).toBe('stale');

    await helplineRepo(pool).flagP0(pool, 'GB', 'ops@tulifo.ai');
    expect((await resolveHelplines(pool, 'GB')).source).toBe('builtin');
  });
});
