import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    // The client holds no provider key and no database credential; it only ever
    // talks to the API. Proxying in dev keeps the browser same-origin so the
    // consent token can move to an httpOnly cookie later without a CORS rethink.
    proxy: { '/v1': 'http://localhost:8080', '/health': 'http://localhost:8080' },
  },
  build: {
    target: 'es2020',
    // §2.1 budget: <= 100 KB gzipped for the chat shell. Vite warns above this,
    // and scripts/check-budget.mjs turns the warning into a failure.
    chunkSizeWarningLimit: 300,
  },
});
