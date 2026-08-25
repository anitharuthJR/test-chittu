/**
 * The dev lane resolves @chittu/* to SOURCES, and has to say so out loud.
 *
 * Every workspace package publishes a conditional export map: `development` ->
 * src/index.ts, default -> dist/index.js. Four lanes read it and every one of
 * them has to opt in SEPARATELY, in its own dialect:
 *
 *   tsc      tsconfig.base.json    "customConditions": ["development"]
 *   vitest   vitest.config.ts      resolve.conditions: ['development']
 *   vite     apps/web/vite.config  (its dev server adds `development` itself)
 *   tsx      package.json          --conditions=development, on every call
 *
 * tsx was the one nobody told. Node's defaults are node/import/default, so
 * `tsx src/migrate.ts` took the default branch and looked for dist/index.js —
 * and `pnpm start` died on any checkout that had not been built:
 *
 *   Cannot find module '…/apps/api/node_modules/@chittu/db/dist/index.js'
 *
 * It hid for as long as it did because dist/ is a leftover: `pnpm verify`'s last
 * lane compiles it, so the second run of the day always worked. A fresh clone —
 * or a fresh worktree, which is how this repo is actually used — got the error.
 *
 * The other half of the bug is worse than the crash and does not announce
 * itself: WITH a stale dist/ present, the unflagged dev loop boots happily and
 * serves the LAST BUILD of packages/safety-kernel. You edit a guard, reload,
 * see the old behaviour, and the honest conclusion to draw is that your change
 * does not work. `tsx watch` cannot watch a file it never loaded.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const API_DIR = here('..');
const TSX = here('../node_modules/.bin/tsx');

type Manifest = { scripts?: Record<string, string> };

const MANIFESTS: Array<[string, Manifest]> = [
  ['package.json', JSON.parse(readFileSync(here('../../../package.json'), 'utf8'))],
  ['apps/api/package.json', JSON.parse(readFileSync(here('../package.json'), 'utf8'))],
];

/** Scripts that shell out to tsx, as [manifest, script name, command]. */
const tsxScripts: Array<[string, string, string]> = MANIFESTS.flatMap(([file, m]) =>
  Object.entries(m.scripts ?? {})
    .filter(([, cmd]) => /(^|\s)tsx(\s|$)/.test(cmd))
    .map(([name, cmd]) => [file, name, cmd] as [string, string, string]),
);

describe('every tsx invocation asks for the development condition', () => {
  it('finds the tsx scripts at all — a rename must not empty this suite', () => {
    // A positive control. Without it, deleting the `migrate` script or spelling
    // tsx differently would leave zero cases and a green run, which is exactly
    // how a sweep looks when it is searching the wrong place.
    expect(tsxScripts.length).toBeGreaterThanOrEqual(4);
    expect(tsxScripts.map(([, name]) => name)).toContain('migrate');
  });

  it.each(tsxScripts)('%s → %s', (_file, _name, cmd) => {
    expect(cmd).toMatch(/--conditions=development/);
  });
});

describe('and tsx honours it', () => {
  /**
   * Run the flags THE MANIFEST carries, not a copy of them — so this proves the
   * script, not a second transcription of it that can drift. Everything between
   * `tsx` and the entry point, which for `migrate` is `--conditions=development`.
   */
  const migrate = tsxScripts.find(([f, n]) => f === 'apps/api/package.json' && n === 'migrate');
  const flags = (migrate?.[2] ?? '').split(/\s+/).filter((w) => w.startsWith('--'));

  /** Where does `@chittu/db` land, resolved from apps/api under these flags? */
  const resolveDb = (extra: string[]): string =>
    execFileSync(
      TSX,
      [...extra, '--input-type=module', '-e', "console.log(await import.meta.resolve('@chittu/db'))"],
      { cwd: API_DIR, encoding: 'utf8' },
    ).trim();

  it("the migrate script's own flags resolve to packages/db/src", () => {
    expect(flags).toContain('--conditions=development');
    expect(resolveDb(flags)).toMatch(/\/packages\/db\/src\/index\.ts$/);
  });

  it('and WITHOUT them it resolves to dist — the flag is what does the work', () => {
    // The negative control matters more than it looks. This assertion reports a
    // PATH rather than success-or-failure, so it is decisive whether or not a
    // dist/ happens to be lying around: with one, the unflagged run does not
    // crash, it silently serves the build. That is the failure mode this whole
    // file exists to stand in front of.
    expect(resolveDb([])).toMatch(/\/dist\/index\.js$/);
  });

  it('because the export map still gates the sources behind `development`', () => {
    const db = JSON.parse(readFileSync(here('../../../packages/db/package.json'), 'utf8'));
    expect(db.exports['.']).toHaveProperty('development');
    expect(db.exports['.'].development).toMatch(/src\//);
  });
});
