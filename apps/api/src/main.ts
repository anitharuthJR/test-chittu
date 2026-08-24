import { buildServer } from './server.js';
import { stubRouter } from './providers.js';

const port = Number(process.env['PORT'] ?? 8080);

// The stub classifies everything SAFE. Starting with it in production would
// mean L2 inspects nothing, so refuse rather than degrade silently.
if (process.env['NODE_ENV'] === 'production') {
  throw new Error(
    'refusing to start: no real provider router is wired yet, and the stub ' +
    'classifies every turn SAFE. See apps/api/src/providers.ts.',
  );
}

const app = buildServer({ router: stubRouter(), logger: true });
await app.listen({ port, host: '127.0.0.1' });
