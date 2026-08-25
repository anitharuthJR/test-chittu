/**
 * The pipeline's ports are wired to the router in server.ts, and the wiring is
 * a place a parameter can be silently dropped.
 *
 * PR #38 gave `classify` a RouteContext so the classifier cell could be routed
 * per band and country, and so clearance could be checked for the child's own
 * jurisdiction instead of the intersection of every enabled market. The router
 * tests passed because they call `router.classify(text, history, ctx)` directly.
 * The server built the port as `(text, history) => router.classify(text, history)`
 * — a two-argument arrow — so ctx never left the pipeline.
 *
 * The symptom would have been invisible: routing quietly ignoring band and
 * country for the classifier, and clearance quietly falling back to the
 * conservative rule. Both "work", both are wrong, and nothing says so.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import type { ProviderRouter } from './providers.js';
import type { RouteContext } from '@chittu/contracts';
import type { FastifyInstance } from 'fastify';

const keys = localKeyProvider(randomBytes(32), 'dev');
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => { fixture = await createTestDb(); pool = fixture.pool; }, 120_000);
afterAll(async () => { await fixture?.close(); });

/** Records the context each port actually received. */
function spyRouter() {
  const seen: { classify: RouteContext | undefined; generate: string | undefined } = {
    classify: undefined, generate: undefined,
  };
  const r: ProviderRouter = {
    route: (c) => ({ provider: 'test', model: 'test-0', promptVersion: `${c}-v0` }),
    async classify(_t, _h, ctx) { seen.classify = ctx; return { label: 'SAFE', memory: null, assist: null }; },
    async generate(input) { seen.generate = input.state.country; return 'Blue sky! [CHIPS]More[/CHIPS]'; },
  };
  return { router: r, seen };
}

async function consentAndSession(app: FastifyInstance, country: string, band: string) {
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: {
      parentName: 'P', parentEmail: `w-${randomUUID()}@example.com`,
      childFirstName: 'C', country, band, method: 'dev_stub',
      pin: '2846', pinConfirm: '2846',
    },
  });
  const { consentId, challengeId } = draft.json() as { consentId: string; challengeId: string };
  const fin = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId },
  });
  const raw = String(fin.headers['set-cookie']).split(';')[0]!;
  const cookies = { chittu_consent: raw.slice(raw.indexOf('=') + 1) };
  const sess = await app.inject({ method: 'POST', url: '/v1/session', cookies, payload: {} });
  return { cookies, sessionId: (sess.json() as { sessionId: string }).sessionId };
}

describe('the pipeline ports carry what the router needs', () => {
  it('classify() receives the band and country of the turn', async () => {
    const { router, seen } = spyRouter();
    const app = await buildServer({ pool, keys, router, rateLimitMax: 100_000 });
    // IN rather than GB: dev_stub is not offered in every jurisdiction, and the
    // seam under test is whether ctx survives the port, not consent coverage.
    const { cookies, sessionId } = await consentAndSession(app, 'IN', 'thinker');

    await app.inject({
      method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'why is the sky blue' },
    });

    expect(seen.classify, 'ctx was dropped between the pipeline and the router')
      .toEqual({ band: 'thinker', country: 'IN' });
    await app.close();
  });

  it('generate() already had them, and still does', async () => {
    const { router, seen } = spyRouter();
    const app = await buildServer({ pool, keys, router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await consentAndSession(app, 'IN', 'explorer');
    await app.inject({
      method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'tell me a story' },
    });
    expect(seen.generate).toBe('IN');
    await app.close();
  });
});
