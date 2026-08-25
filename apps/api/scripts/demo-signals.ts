/**
 * A live /ops/signals with real rows in it. Development only.
 *
 * WHY THIS IS NOT A FIXTURE. `signal_counter` is empty in every environment and
 * no deployment exists, so the only way to see this page is to make some rows —
 * and a hand-written fixture would be an assertion about the schema written by
 * the same person who wrote the code, which is docs/chittu-status.md §8b's
 * failure mode with extra steps. Four things a fixture gets wrong and this
 * cannot: `k_sessions` above 25 (impossible — the count freezes at the floor),
 * a shape with capitals or a seventh placeholder, every facet non-null so the
 * "varies" rendering is never seen, and `failure_class` always set.
 *
 * So this drives REAL TURNS through the real pipeline into the real abstractor.
 * Every row on the page arrived through `signalRepo.observe()`, which means the
 * page is showing what production would show.
 *
 *   pnpm demo:signals          # then open http://127.0.0.1:8080/ops
 *
 * Two operators are configured, because one operator can never approve anything
 * — the four-eyes constraint is the point, not an obstacle.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider } from '@chittu/db';
import { buildServer } from '../src/server.js';
import type { ProviderRouter } from '../src/providers.js';

if (process.env['NODE_ENV'] === 'production') {
  throw new Error('demo-signals is development only');
}

const ARUN = 'a'.repeat(40);
const GRACE = 'g'.repeat(40);

/** Fails the classifier, so every turn records an honest CLASSIFIER_PARSE. */
function failingRouter(mode: 'classifier' | 'sandbox'): ProviderRouter {
  return {
    route: (c) => ({
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: `${c}-v1`,
    }),
    async classify() {
      if (mode === 'classifier') throw new Error('provider down');
      return { label: 'SAFE', memory: null, assist: null };
    },
    async generate() {
      return mode === 'sandbox' ? 'CRISIS' : 'Sunlight scatters! [CHIPS]More[/CHIPS]';
    },
  };
}

const fixture = await createTestDb();
const pool = fixture.pool;
const keys = localKeyProvider(randomBytes(32), 'dev');

/** One family, one session, one turn — the same path a child walks. */
async function turn(text: string, mode: 'classifier' | 'sandbox') {
  const app = await buildServer({
    pool, keys, router: failingRouter(mode), rateLimitMax: 1_000_000, logger: false,
  });
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: {
      parentName: 'P', parentEmail: `demo-${randomUUID()}@example.com`,
      childFirstName: 'C', country: 'IN', band: 'builder', method: 'dev_stub',
      pin: '2846', pinConfirm: '2846',
    },
  });
  const { consentId, challengeId } = draft.json() as { consentId: string; challengeId: string };
  const fin = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId } });
  const raw = String(fin.headers['set-cookie']).split(';')[0]!;
  const cookies = { chittu_consent: raw.slice(raw.indexOf('=') + 1) };
  const sess = await app.inject({ method: 'POST', url: '/v1/session', cookies, payload: {} });
  const { sessionId } = sess.json() as { sessionId: string };
  await app.inject({
    method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies, payload: { text } });
  await app.close();
}

/**
 * Three shapes, deliberately different: one over the floor, one under it, and
 * one that reaches the floor with a DISAGREEING layer so the page's "varies"
 * rendering is exercised by something real.
 */
const SCRIPT: readonly [string, number, 'classifier' | 'sandbox'][] = [
  ['i am really nervous about the olympiad tomorrow', 26, 'classifier'],
  ['my labrador Rusty died and i feel empty inside', 31, 'classifier'],
  ['everything feels like a lot lately', 12, 'sandbox'],
];

let done = 0;
const total = SCRIPT.reduce((n, [, c]) => n + c, 0);
for (const [text, count, mode] of SCRIPT) {
  for (let i = 0; i < count; i += 1) {
    await turn(text, mode);
    done += 1;
    if (done % 10 === 0) process.stdout.write(`  ${done}/${total} turns\n`);
  }
}

const { rows } = await pool.query<{ n: string; ready: string }>(
  `SELECT count(*)::text AS n,
          count(*) FILTER (WHERE shape IS NOT NULL)::text AS ready FROM signal_counter`);
console.log(`\n[demo] ${rows[0]!.n} shapes counted, ${rows[0]!.ready} above the floor\n`);

const app = await buildServer({
  pool, keys, router: failingRouter('classifier'), rateLimitMax: 1_000_000,
  opsTokens: `arun@tulifo.ai=${ARUN},grace@tulifo.ai=${GRACE}`,
});
await app.listen({ port: 8080, host: '127.0.0.1' });
console.log('[demo] http://127.0.0.1:8080/ops');
console.log(`[demo] operator arun@tulifo.ai   token ${ARUN}`);
console.log(`[demo] operator grace@tulifo.ai  token ${GRACE}`);
console.log('[demo] sign in as one to author, the other to approve — that is four eyes.\n');
