import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

/**
 * The client needs a DOM and a JSX transform, which the root Vitest project has
 * neither of. It is a separate project rather than a second environment glob so
 * that `apps/api` keeps running in plain Node — a jsdom `fetch` would quietly
 * change what the API tests are testing.
 */
export default defineConfig({
  plugins: [preact()],
  test: {
    name: 'web',
    environment: 'jsdom',
    // Without an origin jsdom serves `about:blank`, where the storage APIs are
    // present as bare objects with no methods — so `localStorage.getItem` is
    // undefined and every write silently no-ops inside the store's try/catch.
    // The tests would then pass while proving nothing about persistence.
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
    restoreMocks: true,
  },
});
