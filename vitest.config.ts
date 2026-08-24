import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Named so `vitest --project server` works; the client is `web`.
    name: 'server',
    // The prototype harness (tests/*.spec.js) is Playwright's, not Vitest's.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'db/**/*.test.ts'],
    // apps/web is its own project (see vitest.workspace.ts) — it needs jsdom,
    // which would change what the API tests are testing if it applied here.
    exclude: ['**/node_modules/**', 'apps/web/**'],
    testTimeout: 30_000,
    coverage: {
      // safety-kernel is the package a certifier reads. It carries the strictest bar.
      thresholds: { 'packages/safety-kernel/**': { branches: 100, functions: 100, lines: 100 } },
    },
  },
});
