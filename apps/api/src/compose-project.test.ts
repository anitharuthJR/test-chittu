/**
 * One database per REPOSITORY, not one per worktree.
 *
 * This repo is used through 2-3 parallel worktrees (CLAUDE.md), and Compose
 * derives its project name from the DIRECTORY. So every worktree declared its
 * own `<dir>-postgres-1` container, and every one of them tried to publish the
 * same host port. Observed on one machine, mid-session:
 *
 *   reading-coach-feature-cadf43-postgres-1   Up (healthy)  0.0.0.0:55432->5432
 *   d5-maths-certification-be7eb6-postgres-1  Created
 *   focused-banach-f19360-postgres-1          Created
 *   merlyn-grounding-retrieval-37b9f7-postgres-1  Created
 *   angry-yalow-621c29-postgres-1             Created
 *   four-safety-fixes-72391e-postgres-1       Exited (0)
 *
 * Six containers for one logical database, one holding the port and five dead.
 * `pnpm test` in any of the other five failed at `db:up` with a driver error
 * about port allocation — which reads as "Docker is broken", not as "another
 * worktree already has this". `pnpm verify` failed the same way, on the lane
 * that runs the whole suite, so the quality gate was unrunnable in five
 * checkouts out of six.
 *
 * A worse variant was also live: `four-safety-fixes-72391e-postgres-dev-1` was
 * UP with NO published ports at all — a running database nothing could reach.
 *
 * The fix is a pinned project name, which is why this file exists. Test
 * isolation was never the port's job: `createTestDb` builds a throwaway
 * `t_<hex>` schema per FIXTURE, which is what already lets parallel test files
 * share one server, and generalises to parallel worktrees unchanged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const COMPOSE = readFileSync(here('../../../compose.yaml'), 'utf8');
const ROOT_PKG = JSON.parse(readFileSync(here('../../../package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('compose.yaml pins its project name', () => {
  /**
   * The whole fix, in one key. Without it Compose names the project after the
   * directory, and a directory per worktree means a container per worktree.
   */
  it('declares a fixed top-level name, so every worktree shares one project', () => {
    expect(COMPOSE).toMatch(/^name:\s*chittu\s*$/m);
  });

  it('still publishes the two ports the tooling defaults to', () => {
    // vitest.config.ts defaults DATABASE_URL to :55432 and scripts/dev.sh to
    // :55433. Changing a port here without changing those gives a container
    // that is up and a suite that cannot reach it.
    expect(COMPOSE).toMatch(/'55432:5432'/);
    expect(COMPOSE).toMatch(/'55433:5432'/);
  });

  it('routes db:up through the preflight rather than calling compose bare', () => {
    // The raw failure is a Docker driver error naming an endpoint hash. The
    // preflight names the CONTAINER holding the port and what to do about it.
    expect(ROOT_PKG.scripts?.['db:up']).toBe('bash scripts/db-up.sh');
  });

  /**
   * `down -v` on a SHARED project destroys the database for every worktree,
   * including whichever ones are mid-run. It stays available and stays
   * destructive — but it has to say so, because "down" now means something
   * wider than it did when the project was per-directory.
   */
  it('warns that db:down is now repository-wide', () => {
    expect(COMPOSE).toMatch(/every worktree|all worktrees/i);
  });
});

describe('scripts/db-up.sh', () => {
  const SH = readFileSync(here('../../../scripts/db-up.sh'), 'utf8');

  it('names the foreign container holding the port instead of leaving a driver error', () => {
    expect(SH).toMatch(/docker ps/);
    expect(SH).toMatch(/55432/);
  });

  it('still runs compose — the preflight explains a failure, it does not replace the up', () => {
    expect(SH).toMatch(/docker compose .*up -d --wait/);
  });

  /**
   * A preflight that exits 0 when it cannot decide is a preflight that turns a
   * failed `db:up` into a green one, and the suite then fails on connection
   * refused several seconds later with nothing pointing back here.
   */
  it('fails the script when compose fails', () => {
    expect(SH).toMatch(/set -e|exit 1/);
  });

  /**
   * Both databases, one implementation. `pnpm start` died on the SAME driver
   * error as `pnpm test` — a leftover worktree container holding :55433 — and
   * fixing only the test lane would have left the dev lane failing in the way
   * that is hardest to read.
   */
  it('serves the dev database as well as the test one', () => {
    expect(SH).toMatch(/postgres-dev/);
    expect(SH).toMatch(/55433/);
  });

  /**
   * macOS ships bash 3.2, where `"\${A[@]}"` on an EMPTY array under `set -u`
   * is an unbound variable and takes the script down — on the default lane,
   * which is the one everybody runs. Caught by running it, not by reading it.
   */
  it('expands the optional profile array the bash-3.2-safe way', () => {
    expect(SH).not.toMatch(/docker compose "\$\{PROFILE\[@\]\}"/);
    expect(SH).toMatch(/\$\{PROFILE\[@\]\+"\$\{PROFILE\[@\]\}"\}/);
  });
});

describe('scripts/dev.sh goes through the same preflight', () => {
  const DEV = readFileSync(here('../../../scripts/dev.sh'), 'utf8');

  it('calls db-up.sh rather than compose directly', () => {
    expect(DEV).toMatch(/bash scripts\/db-up\.sh dev/);
    expect(DEV).not.toMatch(/docker compose --profile dev up -d --wait postgres-dev/);
  });
});
