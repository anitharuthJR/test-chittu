import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Packages expose conditional exports: `development` -> src/*.ts, default ->
  // dist/*.js so the container can run compiled output without tsx. Vitest must
  // ask for `development`, or the suite silently starts testing the build
  // artefact instead of the TypeScript, and a stale dist/ would pass while the
  // source was broken.
  resolve: { conditions: ['development'] },
  test: {
    // Named so `vitest --project server` works; the client is `web`.
    name: 'server',
    // The prototype harness (tests/*.spec.js) is Playwright's, not Vitest's.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'db/**/*.test.ts'],
    // apps/web is its own project (see vitest.workspace.ts) — it needs jsdom,
    // which would change what the API tests are testing if it applied here.
    exclude: ['**/node_modules/**', 'apps/web/**'],
    testTimeout: 30_000,
    // The suite runs on a real Postgres (`pnpm db:up` starts it; `pnpm test`
    // does it for you). Defaulted HERE rather than only in the package.json
    // script so the targeted invocations CLAUDE.md documents — `pnpm vitest run
    // --project server packages/safety-kernel` and friends — keep working
    // without every caller exporting it. An exported DATABASE_URL still wins.
    env: {
      DATABASE_URL: process.env['DATABASE_URL']
        ?? 'postgres://chittu:chittu@localhost:55432/chittu_test',
    },
    coverage: {
      // safety-kernel is the package a certifier reads. It carries the strictest bar.
      thresholds: { 'packages/safety-kernel/**': { branches: 100, functions: 100, lines: 100 } },
    },
  },
});
