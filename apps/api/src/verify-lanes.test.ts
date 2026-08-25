/**
 * The container lane runs BY DEFAULT, it may not touch the shared dev database,
 * and it may not bind a port anyone else wants.
 *
 * Three facts forced this file.
 *
 * ONE — the lane is the only one that drives the artifact that actually ships,
 * and it was opt-in behind `--with-container` while no CI existed to pass that
 * flag. So nothing ran it, and `@chittu/reading-coach` shipped an image that
 * could not boot for eight commits with 1881 tests green (#66). A check nobody
 * runs is not a check.
 *
 * TWO — turning it on by default multiplies whatever it destroys by every run.
 * It tore down with `docker compose --profile dev down -v`, and compose.yaml
 * pins `name: chittu`, so `-v` removed `chittu-dev-data` — the ONE dev database
 * this repository shares across every worktree (#59). Opt-in, that is a cost
 * someone typed a flag to accept. Default, it means every pre-merge check
 * silently wipes the dev data of every worktree on the machine.
 *
 * THREE — and this one was found by running it: compose.yaml publishes FIXED
 * host ports, and this repo is worked through 2-3 parallel worktrees sharing
 * that same pinned project. The first default run failed because another
 * session had the dev stack up and :55433 was taken. Nothing was wrong with the
 * code. A gate that goes red on its own is a gate people learn to ignore, so
 * the lane publishes an ephemeral api port and no database port at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VERIFY = readFileSync(here('../../../scripts/verify.sh'), 'utf8');
const LANE = readFileSync(here('../../../scripts/verify-container.sh'), 'utf8');
const OVERLAY = readFileSync(here('../../../compose.verify.yaml'), 'utf8');

describe('pnpm verify — the container lane', () => {
  /**
   * POSITIVE CONTROL. Every assertion below is a claim about the text of a
   * file; all of them pass vacuously against an empty read or a typo'd path.
   */
  it('actually read all three files', () => {
    expect(VERIFY).toContain('#!/usr/bin/env bash');
    expect(LANE).toContain('smoke-dist.mjs');
    expect(OVERLAY).toContain('services:');
    expect(VERIFY.length).toBeGreaterThan(1000);
    expect(LANE.length).toBeGreaterThan(500);
  });

  it('is ON by default — no flag required', () => {
    expect(VERIFY).toMatch(/^WITH_CONTAINER=1$/m);
    expect(VERIFY).toMatch(/bash scripts\/verify-container\.sh/);
  });

  it('can be turned off, because it is the slow lane', () => {
    expect(VERIFY).toMatch(/--no-container\)/);
  });

  /**
   * `--with-container` was the documented way to ask for this lane for months.
   * It now asks for what it already has, so it must keep PARSING — falling into
   * "unknown flag" and exiting 2 would break every muscle memory and every doc
   * that predates the change. Same courtesy the removed --with-pg gets.
   */
  it('still accepts --with-container rather than erroring on it', () => {
    expect(VERIFY).toMatch(/--with-container\)/);
  });

  /**
   * THE ONE THAT MATTERS MOST. `down -v` is destructive and the project name is
   * the only thing deciding whose volume it destroys. Every compose call must
   * name the throwaway project; one that does not is pointed at `chittu`, where
   * the shared dev database lives.
   */
  it('never invokes docker compose without naming its own project', () => {
    const calls = [...LANE.matchAll(/docker compose[^\n]*/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/-p "\$PROJECT"/);
    }
  });

  it('defaults that project to something other than the shared one', () => {
    expect(LANE).toMatch(/PROJECT="\$\{VERIFY_PROJECT:-chittu-verify\}"/);
    expect(LANE).not.toMatch(/PROJECT="?chittu"?$/m);
  });

  /** Every compose call must carry the overlay, or the fixed ports come back. */
  it('always passes the overlay alongside compose.yaml', () => {
    const calls = [...LANE.matchAll(/docker compose[^\n]*/g)].map((m) => m[0]);
    for (const call of calls) {
      expect(call).toContain('-f compose.yaml');
      expect(call).toContain('-f compose.verify.yaml');
    }
  });

  /**
   * Compose MERGES sequences. Without `!override` these lists are appended to
   * the fixed ports rather than replacing them, the lane binds 8080 again, and
   * the collision this overlay exists to prevent comes back — silently, because
   * the file would still look correct.
   */
  it('overrides the ports rather than adding to them', () => {
    expect(OVERLAY).toMatch(/ports:\s*!override/);
    expect((OVERLAY.match(/!override/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('publishes no database port and no fixed api port', () => {
    // Comments stripped first: this file EXPLAINS which fixed ports it is
    // dropping, so asserting against the raw text would fail on its own prose
    // and pressure the next person to delete the explanation.
    const yaml = OVERLAY.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(yaml).toMatch(/postgres-dev:\s*\n\s*ports:\s*!override\s*\[\]/);
    expect(yaml).not.toMatch(/'8080:8080'/);
    expect(yaml).not.toMatch(/55433/);
    // The api keeps a port line — a bare container port, which is what makes
    // Docker choose a free host one.
    expect(yaml).toMatch(/api:\s*\n\s*ports:\s*!override\s*\n\s*- '8080'/);
  });

  /**
   * A killed run must not leave a stack holding a volume. The teardown is on a
   * trap rather than only at the end, because the health-wait has an exit path
   * of its own and Ctrl-C has no exit path at all.
   */
  it('tears down on every exit path, not just the happy one', () => {
    expect(LANE).toMatch(/trap teardown EXIT/);
    expect(LANE).toMatch(/teardown\(\)\s*\{[^}]*down -v/);
  });
});
