import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// dev.sh exports PORT as the API's port before launching either dev server —
// same variable, read the same way as its own `API_PORT="${PORT:-8080}"` — so
// a worktree started with a non-default PORT (the WEB_PORT collision fix in #51
// made that the normal case, not the exception) gets a proxy that actually
// reaches its own API instead of silently targeting :8080. Unset, the API
// itself defaults there too, so the fallback still matches a plain `pnpm start`.
const apiPort = process.env['PORT'] ?? '8080';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    // The client holds no provider key and no database credential; it only ever
    // talks to the API. Proxying in dev keeps the browser same-origin so the
    // consent token can move to an httpOnly cookie later without a CORS rethink.
    proxy: { '/v1': `http://localhost:${apiPort}`, '/health': `http://localhost:${apiPort}` },
  },
  build: {
    target: 'es2020',
    // §2.1 budget: <= 100 KB gzipped for the chat shell. Vite warns above this,
    // and scripts/check-budget.mjs turns the warning into a failure.
    chunkSizeWarningLimit: 300,
  },
});
