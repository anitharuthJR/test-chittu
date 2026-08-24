import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The prototype harness (tests/*.spec.js) is Playwright's, not Vitest's.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'db/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      // safety-kernel is the package a certifier reads. It carries the strictest bar.
      thresholds: { 'packages/safety-kernel/**': { branches: 100, functions: 100, lines: 100 } },
    },
  },
});
