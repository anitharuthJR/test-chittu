/**
 * The Dockerfile enumerates workspace packages BY HAND, twice, and a package
 * missing from either list is invisible until the container boots.
 *
 * `@chittu/reading-coach` landed in #58 and was added to neither list. The
 * consequences, in order:
 *
 *   - the `base` stage never copied `packages/reading-coach/package.json`,
 *   - `pnpm install --frozen-lockfile` in `prod-deps` linked the dependency
 *     anyway — `apps/api/node_modules/@chittu/reading-coach` exists in the
 *     image, pointing at a directory that does not,
 *   - the `build` stage DID compile it, because it does `COPY packages
 *     ./packages` wholesale, so every build succeeded,
 *   - and the runtime stage copied nine `dist` directories out of ten.
 *
 * So the image built clean, `pnpm test` was green on 1881 tests, and the
 * artifact died on its first line:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@chittu/reading-coach'
 *   imported from /app/apps/api/dist/server.js
 *
 * This is the failure CLAUDE.md already names — "`pnpm test` proves nothing
 * about the artifact that ships" — recurring for the second time, because the
 * first fix was a rule for humans to remember rather than a test. The container
 * lane does catch it — but it was opt-in behind `--with-container`, and CI was
 * removed on 2026-08-25, so nothing passed that flag and nothing cheap failed.
 * That lane runs by default now; this file is still the fast half of the answer.
 *
 * This is the cheap thing. It reads the Dockerfile as text and asserts the two
 * lists still cover `packages/`, so the next package added is a red test in
 * seconds rather than a dead container in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DOCKERFILE = readFileSync(here('../Dockerfile'), 'utf8');
const PACKAGES_DIR = here('../../../packages');

/** Every workspace package on disk — the thing both lists have to cover. */
const workspacePackages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => existsSync(`${PACKAGES_DIR}/${name}/package.json`))
  .sort();

describe('apps/api/Dockerfile covers every workspace package', () => {
  /**
   * POSITIVE CONTROL. Every other assertion in this file is "the Dockerfile
   * mentions X". All of them pass vacuously if the directory scan returns
   * nothing — a sweep that finds nothing looks exactly like one looking in the
   * wrong place. Same rule as signals.test.ts.
   */
  it('actually found the workspace packages', () => {
    expect(workspacePackages.length).toBeGreaterThanOrEqual(9);
    expect(workspacePackages).toContain('safety-kernel');
    expect(workspacePackages).toContain('reading-coach');
  });

  /**
   * List one: the manifests, copied in `base` so the dependency layer resolves
   * without invalidating on a source edit. A package missing here still LINKS
   * — pnpm follows the lockfile — it just links to nothing.
   */
  it.each(workspacePackages)('copies packages/%s/package.json in the base stage', (name) => {
    expect(DOCKERFILE).toContain(`COPY packages/${name}/package.json`);
  });

  /**
   * List two: the compiled output, copied into the distroless runtime. This is
   * the one whose absence produced ERR_MODULE_NOT_FOUND — the symlink was
   * present and its target was not.
   */
  it.each(workspacePackages)('copies packages/%s/dist into the runtime stage', (name) => {
    expect(DOCKERFILE).toContain(`/app/packages/${name}/dist`);
  });

  /**
   * The two lists must be the SAME set. A package in one and not the other is
   * the exact shape of this bug, and asserting each list against the directory
   * separately would still pass if someone "fixed" only the half that appeared
   * in the stack trace.
   */
  it('both lists name the same packages', () => {
    const manifests = [...DOCKERFILE.matchAll(/COPY packages\/([\w-]+)\/package\.json/g)]
      .map((m) => m[1])
      .sort();
    const dists = [...DOCKERFILE.matchAll(/\/app\/packages\/([\w-]+)\/dist/g)]
      .map((m) => m[1])
      .sort();

    expect(manifests).toEqual(dists);
    expect(manifests).toEqual(workspacePackages);
  });
});
