/**
 * The boot banner must describe the server it is printed by.
 *
 * It did not. `main.ts` answered "is the grounded corpus live" with its own
 * `router.route('embedding')` call — a second opinion about a decision
 * `buildServer` makes somewhere else — and it disagreed with that decision in
 * BOTH directions:
 *
 *   - **stub router → banner said ON.** `stubRouter().route()` answers every
 *     category with `{provider:'stub', model:'stub-0'}` and never throws, so
 *     boot printed `grounded corpus: ON — stub/stub-0` while `embedderFor`
 *     returned null, no grounding port was wired, and no walk ever contained
 *     CORPUS. Observed live on 2026-08-25.
 *
 *   - **Anthropic-only → banner said OFF, and the layer was stamped anyway.**
 *     `createRouter` always defines `embed`, so `embedderFor` hands back a live
 *     embedder even when `DEFAULT_CELLS.embedding` names `local` and no local
 *     adapter exists. The port was wired, CORPUS appeared in every sandbox
 *     walk, and every retrieval reported UNAVAILABLE — under a banner that said
 *     OFF and a line that promised "no CORPUS layer will be stamped". That is
 *     every Anthropic-only deployment, which status §2b says is all of them.
 *
 * So these tests do not check the banner's wording against a fixture. They
 * check it against THE WALK — what a real turn through a real server actually
 * stamps — because that is the claim the banner is making.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import { stubRouter, type ProviderRouter } from './providers.js';
import { corpusStatus, embedderFor } from './corpus/embed.js';
import { createRouter } from './providers/router.js';
import type { ProviderAdapter } from '@chittu/contracts';
import type { FastifyInstance } from 'fastify';

const keys = localKeyProvider(randomBytes(32), 'dev');
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { fixture = await createTestDb(); pool = fixture.pool; }, 120_000);
afterAll(async () => { await fixture?.close(); });

/**
 * An Anthropic-only deployment: the shape every real one has today.
 *
 * THE REAL `createRouter`, with a real `DEFAULT_CELLS` — the embedding cell
 * names `local` and there is no local adapter, which is the whole point. Only
 * the vendor behind the Anthropic adapter is faked, so `classify` and
 * `generate` succeed and the turn reaches the trace-building path where the
 * CORPUS note is written. A router whose completions also fail ends the turn at
 * `SANDBOX · unavailable` and never says anything about the corpus at all,
 * which would have made the assertion below vacuous.
 */
const anthropicOnly = (): ProviderRouter => createRouter({
  adapters: { anthropic: fakeVendor() },
});

/** An adapter with no `embed`, answering completions from memory. */
function fakeVendor(): ProviderAdapter {
  return {
    id: 'anthropic',
    controlTokens: /<\/?think>/gi,
    async complete(req) {
      const classifier = /safety\+memory classifier/i.test(req.system);
      return {
        text: classifier
          ? '{"label":"SAFE","memory":null,"assist":null}'
          : 'Sunlight scatters blue light! [CHIPS]More[/CHIPS]',
        tokensIn: 10, tokensOut: 5,
      };
    },
    // No `embed`, exactly like the real Anthropic adapter — Anthropic ships no
    // embeddings API and no cell assignment can confer one.
  };
}

/** A router that CAN embed, so the `on` state has something to be. */
function embeddingRouter(): ProviderRouter {
  return {
    route: (c) => ({ provider: 'local', model: 'mxbai-embed-large', promptVersion: `${c}-v1` }),
    async classify() { return { label: 'SAFE', memory: null, assist: null }; },
    async generate() { return 'Sunlight scatters blue light! [CHIPS]More[/CHIPS]'; },
    async embed() { return new Array(1024).fill(0.01); },
  };
}

async function open_(app: FastifyInstance) {
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: { parentName: 'P', parentEmail: `cs-${randomUUID()}@example.com`,
      childFirstName: 'C', country: 'IN', band: 'builder', method: 'dev_stub',
      pin: '2846', pinConfirm: '2846' } });
  const { consentId, challengeId } = draft.json() as { consentId: string; challengeId: string };
  const fin = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId } });
  const raw = String(fin.headers['set-cookie']).split(';')[0]!;
  const cookies = { chittu_consent: raw.slice(raw.indexOf('=') + 1) };
  const sess = await app.inject({ method: 'POST', url: '/v1/session', cookies, payload: {} });
  return { cookies, sessionId: (sess.json() as { sessionId: string }).sessionId };
}

/** Drive one sandbox turn and report what the server said AND what it walked. */
async function drive(router: ProviderRouter) {
  const app = await buildServer({ pool, keys, router, rateLimitMax: 100_000 });
  const { cookies, sessionId } = await open_(app);
  const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`,
    cookies, payload: { text: 'why is the sky blue' } });
  await app.close();
  const body = r.json() as { layers: string[]; trace: string };
  return { corpus: app.corpus, layers: body.layers, trace: body.trace };
}

// ---------------------------------------------------------------------------

describe('the banner and the wiring cannot disagree', () => {
  it.each([
    ['the stub router', stubRouter],
    ['an Anthropic-only deployment', anthropicOnly],
    ['an embedding-capable router', embeddingRouter],
  ])('%s: portWired is exactly `embedderFor() !== null`', async (_n, make) => {
    const router = make();
    const embedder = embedderFor(router);
    expect(corpusStatus(router, embedder).portWired).toBe(embedder !== null);
  });

  it('`off` is reported when and only when no embedder exists', () => {
    expect(corpusStatus(stubRouter(), null).state).toBe('off');
    expect(corpusStatus(embeddingRouter(), embedderFor(embeddingRouter()))!.state)
      .not.toBe('off');
  });
});

describe('THE STUB ROUTER — the case that printed ON with nothing behind it', () => {
  it('reports OFF, not ON — `route()` answering everything is not a capability', async () => {
    const r = stubRouter();
    // The old banner's whole basis, still true and still not evidence of anything.
    expect(() => r.route('embedding'), 'the stub still answers every route').not.toThrow();
    expect(r.route('embedding').provider).toBe('stub');

    const status = corpusStatus(r, embedderFor(r));
    expect(status.state).toBe('off');
    expect(status.banner).toMatch(/^OFF/);
    expect(status.banner, 'the banner still names the stub as a provider')
      .not.toContain('stub-0');
  });

  it('and a real turn stamps NO CORPUS layer — which is what OFF promises', async () => {
    const r = await drive(stubRouter());
    expect(r.corpus.state).toBe('off');
    expect(r.layers, 'a layer was stamped for a port that was never wired')
      .not.toContain('CORPUS');
    expect(r.trace).not.toMatch(/CORPUS/);
  }, 120_000);
});

describe('AN ANTHROPIC-ONLY DEPLOYMENT — the case that printed OFF and stamped anyway', () => {
  it('reports UNAVAILABLE, because a port IS wired', () => {
    const r = anthropicOnly();
    // The embedding cell names `local`, and there is no local adapter.
    expect(() => r.route('embedding')).toThrow();
    // But the router has an `embed` method, so an embedder is built regardless.
    expect(embedderFor(r), 'no embedder — then this whole case is moot').not.toBeNull();

    const status = corpusStatus(r, embedderFor(r));
    expect(status.state).toBe('unavailable');
    expect(status.portWired).toBe(true);
    expect(status.banner).toMatch(/^UNAVAILABLE/);
    // The router's own words, so an operator can act on it.
    expect(status.banner).toMatch(/no adapter configured/);
  });

  it('and a real turn DOES stamp CORPUS, marked UNAVAILABLE — as the banner now says',
    async () => {
      const r = await drive(anthropicOnly());
      expect(r.corpus.state).toBe('unavailable');
      // The claim the old banner's follow-up line denied, in the deployments
      // that were the only ones ever to read it.
      expect(r.layers, 'the port was wired but no layer was stamped').toContain('CORPUS');
      expect(r.trace).toContain('CORPUS UNAVAILABLE');
      expect(r.trace, 'a refusal was reported as an empty corpus').not.toContain('CORPUS MISS');
    }, 120_000);
});

describe('AN EMBEDDING-CAPABLE ROUTER — the state the banner is supposed to describe', () => {
  it('reports ON, names the model, and stamps a CORPUS layer', async () => {
    const r = await drive(embeddingRouter());
    expect(r.corpus.state).toBe('on');
    expect(r.corpus.banner).toBe('ON — local/mxbai-embed-large');
    expect(r.layers).toContain('CORPUS');
    // An empty corpus is a MISS — a fact about the corpus, not about routing.
    expect(r.trace).toContain('CORPUS MISS');
    expect(r.trace).not.toContain('CORPUS UNAVAILABLE');
  }, 120_000);
});

describe('it reports the embedder that was WIRED, not one it re-derived', () => {
  /**
   * THE STRUCTURAL CLAIM, and the only test that can tell the difference.
   *
   * `buildServer` takes `opts.embed` and falls back to `embedderFor(router)`.
   * Everywhere else in this file those two are the same value, so a version
   * that re-derived `embedderFor(router)` for the banner would pass every other
   * test here while being exactly the bug this change exists to fix: a banner
   * that computes its own answer instead of reporting the decision.
   *
   * Injecting an embedder into a router that has none forces them apart. The
   * port IS wired — CORPUS will be stamped on every turn — and a banner reading
   * `embedderFor(stubRouter())` would say OFF.
   */
  const injected = async () => new Array(1024).fill(0.02) as number[];

  it('an injected embedder is reported as wired, though the router has none', async () => {
    const router = stubRouter();
    expect(embedderFor(router), 'the router must have none for this to mean anything')
      .toBeNull();

    const app = await buildServer({
      pool, keys, router, embed: injected, rateLimitMax: 100_000 });
    expect(app.corpus.portWired, 'the banner ignored the embedder it was handed')
      .toBe(true);
    expect(app.corpus.state).not.toBe('off');
    await app.close();
  }, 120_000);

  it('and the walk agrees — CORPUS is stamped, exactly as the banner promises', async () => {
    const app = await buildServer({
      pool, keys, router: stubRouter(), embed: injected, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`,
      cookies, payload: { text: 'why is the sky blue' } });
    const body = r.json() as { layers: string[]; trace: string };
    expect(app.corpus.portWired).toBe(true);
    expect(body.layers).toContain('CORPUS');
    await app.close();
  }, 120_000);
});

describe('the three states name three different traces', () => {
  it('no two banners could be mistaken for each other', () => {
    const banners = [
      corpusStatus(stubRouter(), null).banner,
      corpusStatus(anthropicOnly(), embedderFor(anthropicOnly())).banner,
      corpusStatus(embeddingRouter(), embedderFor(embeddingRouter())).banner,
    ];
    expect(new Set(banners.map((b) => b.split(' ')[0])))
      .toEqual(new Set(['OFF', 'UNAVAILABLE', 'ON']));
  });
});
