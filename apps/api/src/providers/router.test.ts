/**
 * The provider router, driven over real HTTP against a local stub.
 *
 * There is no `ANTHROPIC_API_KEY` in this environment and CI must never need
 * one, so a Node server stands in for the vendor. That is weaker than a live
 * call in exactly one way — it does not prove Anthropic accepts our request
 * shape — and stronger in every other: the request body, headers, timeouts,
 * retries, error mapping and control-token stripping are all exercised through
 * `fetch`, not mocked away.
 *
 * The unverified part is recorded in PORT-REVIEW rather than papered over.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicAdapter, ProviderError } from './anthropic.js';
import { createRouter, RouteRefused, DEFAULT_CELLS } from './router.js';
import { resolveCells } from './cells.js';
import type { ModelUsage } from '@chittu/contracts';
import type { SessionState } from '@chittu/pipeline';
import { createTestDb } from '@chittu/db';
import { readClearance, toJurisdiction } from './clearance.js';

// --- a stand-in for the vendor ---------------------------------------------

interface Recorded { headers: Record<string, string>; body: any }

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
/** Set per test: what the fake vendor should do next. */
let respond: (n: number) => { status: number; body: unknown; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      recorded.push({
        headers: req.headers as Record<string, string>,
        body: raw === '' ? null : JSON.parse(raw),
      });
      const r = respond(recorded.length - 1);
      const send = () => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  recorded = [];
  respond = () => ({ status: 200, body: text('{"label":"SAFE","memory":null,"assist":null}') });
});

const text = (t: string) => ({
  content: [{ type: 'text', text: t }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const adapter = (over: Partial<Parameters<typeof anthropicAdapter>[0]> = {}) =>
  anthropicAdapter({
    apiKey: 'test-key-not-a-real-one', baseUrl,
    sleep: async () => {},              // no real backoff in tests
    ...over,
  });

const router = (over: Partial<Parameters<typeof createRouter>[0]> = {}) =>
  createRouter({ adapters: { anthropic: adapter() }, ...over });

const state = (over: Partial<SessionState> = {}): SessionState => ({
  kid: 'Meera', band: 'builder', country: 'IN', board: 'CBSE', mode: 'chat',
  crisisLock: false, memOn: true, memories: [], mathPractice: null,
  history: [], spineCount: 0, flags: [], topics: [], assists: [],
  lastSubject: null, ...over,
} as SessionState);

// ---------------------------------------------------------------------------

describe('route()', () => {
  it('names a provider, model and prompt version for every vendor cell', () => {
    const r = router();
    for (const category of Object.keys(DEFAULT_CELLS) as (keyof typeof DEFAULT_CELLS)[]) {
      const d = r.route(category);
      expect(d.provider).toBe('anthropic');
      expect(d.model).toBeTruthy();
      expect(d.promptVersion).toBeTruthy();
    }
  });

  it('REFUSES an uncleared provider rather than falling back to it', async () => {
    // Requirements §3 leaves minors-use terms open (Seat 10). This is the
    // switch that turns a vendor off for a jurisdiction with no code change.
    const r = router({ cleared: new Set<string>() });
    expect(() => r.route('sandbox')).toThrow(RouteRefused);
    await expect(r.classify('hello', [])).rejects.toThrow(RouteRefused);
    await expect(r.generate({ text: 'hello', state: state(), subject: null }))
      .rejects.toThrow(RouteRefused);
    expect(recorded, 'an uncleared provider is never called').toHaveLength(0);
  });

  it('refuses a cell with no adapter configured', () => {
    expect(() => createRouter({ adapters: {} }).route('classifier')).toThrow(RouteRefused);
  });

  it('routes on band and country, most specific first', async () => {
    const r = router({
      scopedCells: resolveCells({
        rows: [
          { category: 'sandbox', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
          { category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'GB' },
          { category: 'sandbox', provider: 'anthropic', model: 'claude-sonnet-5', country: 'GB', band: 'thinker' },
        ],
      }),
    });
    expect(r.route('sandbox', { band: 'explorer', country: 'IN' }).model)
      .toBe('claude-haiku-4-5-20251001');
    expect(r.route('sandbox', { band: 'explorer', country: 'GB' }).model)
      .toBe('claude-opus-5');
    expect(r.route('sandbox', { band: 'thinker', country: 'GB' }).model)
      .toBe('claude-sonnet-5');
  });

  it('generate() routes with the band and country of the turn', async () => {
    const r = router({
      scopedCells: resolveCells({
        rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'GB' }],
      }),
    });
    await r.generate({ text: 'hi', state: state({ country: 'GB' }), subject: null });
    expect(recorded[0]!.body.model).toBe('claude-opus-5');
    await r.generate({ text: 'hi', state: state({ country: 'IN' }), subject: null });
    expect(recorded[1]!.body.model).toBe(DEFAULT_CELLS.sandbox.model);
  });

  it('classify() routes with them too — the whole reason the port changed', async () => {
    const r = router({
      scopedCells: resolveCells({
        rows: [{ category: 'classifier', provider: 'anthropic', model: 'claude-opus-5', band: 'thinker' }],
      }),
    });
    await r.classify('hello', [], { band: 'thinker', country: 'IN' });
    expect(recorded[0]!.body.model).toBe('claude-opus-5');
    await r.classify('hello', [], { band: 'explorer', country: 'IN' });
    expect(recorded[1]!.body.model).toBe(DEFAULT_CELLS.classifier.model);
  });

  it('routes homework and learn to their own cells', async () => {
    const r = router();
    await r.generate({ text: 'help', state: state({ mode: 'homework' }), subject: null });
    expect(recorded[0]!.body.model).toBe(DEFAULT_CELLS.homework.model);
    await r.generate({ text: 'why', state: state({ mode: 'learn' }), subject: null });
    expect(recorded[1]!.body.model).toBe(DEFAULT_CELLS.curriculum.model);
  });
});

describe('the request we actually send', () => {
  it('carries the key in a header and never in the body', async () => {
    await router().classify('hello', []);
    const req = recorded[0]!;
    expect(req.headers['x-api-key']).toBe('test-key-not-a-real-one');
    expect(req.headers['anthropic-version']).toBeTruthy();
    expect(JSON.stringify(req.body)).not.toContain('test-key-not-a-real-one');
  });

  it('sends the classifier prompt and a numbered window of the child\'s turns', async () => {
    await router().classify('and now this one', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a reply that is NOT the child' },
      { role: 'user', content: 'second' },
    ]);
    const body = recorded[0]!.body;
    expect(body.system).toMatch(/safety\+memory classifier/);
    // Chittu's own replies are not the child's turns and must not be judged as
    // though they were.
    expect(body.messages[0].content).not.toMatch(/NOT the child/);
    expect(body.messages[0].content).toBe(
      '[msg 1] first\n[msg 2] second\n[msg 3] and now this one');
  });

  it('sends the sandbox prompt with the band, board and child name', async () => {
    await router().generate({
      text: 'why is the sky blue',
      state: state({ band: 'explorer', board: 'TN', kid: 'Arjun' }),
      subject: 'science',
    });
    const body = recorded[0]!.body;
    expect(body.system).toMatch(/The child is 4-7/);
    expect(body.system).toMatch(/Under 30 words/);
    expect(body.system).toMatch(/Samacheer Kalvi/);
    expect(body.system).toMatch(/Child's first name: "Arjun"/);
    expect(body.messages.at(-1).content).toBe('why is the sky blue');
  });

  it('omits memories when the parent switched memory off', async () => {
    const memories = [{ id: 'm1', category: 'PET' as const, fact: 'has a cat named Mani', since: '' }];
    await router().generate({
      text: 'hi', state: state({ memOn: false, memories }), subject: null });
    expect(recorded[0]!.body.system).not.toMatch(/Mani/);

    await router().generate({
      text: 'hi', state: state({ memOn: true, memories }), subject: null });
    expect(recorded[1]!.body.system).toMatch(/Mani/);
  });
});

describe('the classifier never invents a SAFE', () => {
  it('parses a well-formed CRISIS', async () => {
    respond = () => ({ status: 200, body: text('{"label":"CRISIS","memory":null,"assist":null}') });
    expect((await router().classify('x', [])).label).toBe('CRISIS');
  });

  it('maps IDENTITY and SECRET to SPINE', async () => {
    for (const l of ['IDENTITY', 'SECRET']) {
      respond = () => ({ status: 200, body: text(`{"label":"${l}"}`) });
      expect((await router().classify('x', [])).label).toBe('SPINE');
    }
  });

  it.each([
    ['prose instead of JSON', 'That one seems fine to me!'],
    ['an invented label', '{"label":"PROBABLY_FINE"}'],
    ['a truncated reply', '{"label":"SA'],
    ['an empty completion', ''],
  ])('THROWS on %s — it does not fall back to SAFE', async (_n, reply) => {
    respond = () => ({ status: 200, body: text(reply) });
    await expect(router().classify('x', [])).rejects.toThrow();
  });

  it('throws when the vendor errors, so the turn is marked FAST-PATH-ONLY', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    await expect(router().classify('x', [])).rejects.toThrow(ProviderError);
  });
});

describe('failure handling', () => {
  it('retries a 429 once and succeeds', async () => {
    respond = (n) => n === 0
      ? { status: 429, body: { error: { message: 'rate limited' } } }
      : { status: 200, body: text('{"label":"SAFE"}') };
    expect((await router().classify('x', [])).label).toBe('SAFE');
    expect(recorded).toHaveLength(2);
  });

  it('does NOT retry a 400 — repeating a bad request just burns time', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    await expect(router().classify('x', [])).rejects.toThrow(ProviderError);
    expect(recorded).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    respond = () => ({ status: 503, body: { error: { message: 'unavailable' } } });
    await expect(router().classify('x', [])).rejects.toThrow(/503/);
    expect(recorded).toHaveLength(2);
  });

  it('times out rather than hanging a child\'s turn', async () => {
    respond = () => ({ status: 200, body: text('{"label":"SAFE"}'), delayMs: 300 });
    const r = createRouter({
      adapters: { anthropic: adapter({ timeoutMs: 50, maxRetries: 0 }) } });
    await expect(r.classify('x', [])).rejects.toThrow(/timed out/);
  });

  it('treats an empty completion as a failure, not as silence', async () => {
    respond = () => ({ status: 200, body: { content: [] } });
    await expect(router().generate({ text: 'hi', state: state(), subject: null }))
      .rejects.toThrow(/empty completion/);
  });

  it('never puts the child\'s words into the error message', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    try {
      await router().generate({
        text: 'my secret is that i live at 4 Elm Street', state: state(), subject: null });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Elm Street/);
    }
  });
});

describe('the vendor\'s own litter is stripped before the pipeline sees it', () => {
  it('removes reasoning tags and special tokens', async () => {
    respond = () => ({ status: 200, body: text('<think>plan</think>Sunlight scatters blue!<|end|>') });
    const out = await router().generate({ text: 'why', state: state(), subject: null });
    expect(out).toBe('plan Sunlight scatters blue!');
    // Note what survives: only the literal `</think>` triggers the kernel's
    // slice, and this adapter only strips tags. L6 runs after this and is what
    // actually stands between the model and the child.
    expect(out).not.toMatch(/<\||<think>/);
  });
});

describe('clearance is checked for the CHILD\'s country, not the intersection', () => {
  /**
   * Until routing knew the country, a provider was usable only if it was
   * cleared for EVERY enabled market — the conservative intersection, and a
   * documented limitation (clearance.ts, PORT-REVIEW). With the country in
   * hand the question becomes the one the table actually answers.
   */
  const clearedByCountry = new Map<string, ReadonlySet<string>>([
    ['anthropic', new Set(['IN'])],
  ]);

  it('routes for a child in a country the provider IS cleared for', () => {
    const r = router({ cleared: new Set<string>(), clearedByCountry });
    expect(r.route('sandbox', { band: 'builder', country: 'IN' }).provider).toBe('anthropic');
  });

  it('REFUSES for a child in a country it is not cleared for', () => {
    const r = router({ cleared: new Set<string>(), clearedByCountry });
    expect(() => r.route('sandbox', { band: 'builder', country: 'GB' })).toThrow(RouteRefused);
  });

  it('GB and UK are the same market here too', () => {
    const ukOnly = new Map<string, ReadonlySet<string>>([['anthropic', new Set(['UK'])]]);
    const r = router({ cleared: new Set<string>(), clearedByCountry: ukOnly });
    expect(r.route('sandbox', { band: 'builder', country: 'GB' }).provider).toBe('anthropic');
  });

  it('falls back to the conservative intersection when the country is unknown', () => {
    // No context: we do not know who this is for, so the old rule applies.
    const r = router({ cleared: new Set<string>(), clearedByCountry });
    expect(() => r.route('sandbox')).toThrow(RouteRefused);
  });
});

describe('provider clearance', () => {
  it('clears a provider only when EVERY enabled market is covered', async () => {
    const fixture = await createTestDb();
    try {
      const ins = async (provider: string, jurisdiction: string, over = '') => {
        await fixture.pool.query(
          `INSERT INTO provider_clearance
             (provider, jurisdiction, terms_version, cleared_by, expires_at${over ? ', revoked_at' : ''})
           VALUES ($1,$2,'v1','seat-10', now() + interval '1 year'${over ? ', now()' : ''})`,
          [provider, jurisdiction]);
      };
      await ins('anthropic', 'IN');
      await ins('anthropic', 'US');
      await ins('google', 'IN');          // one market only

      const both = await readClearance(fixture.pool, ['IN', 'US']);
      expect([...both.cleared]).toEqual(['anthropic']);
      expect(both.partial['google']).toEqual(['US']);

      const one = await readClearance(fixture.pool, ['IN']);
      expect([...one.cleared].sort()).toEqual(['anthropic', 'google']);
    } finally { await fixture.close(); }
  }, 120_000);

  it('clears nothing when no market is enabled', async () => {
    // Not knowing who we serve is a reason to call no vendor, not a reason to
    // call every vendor.
    const fixture = await createTestDb();
    try {
      expect((await readClearance(fixture.pool, [])).cleared.size).toBe(0);
    } finally { await fixture.close(); }
  }, 120_000);

  it('ignores revoked and expired clearances', async () => {
    const fixture = await createTestDb();
    try {
      await fixture.pool.query(
        `INSERT INTO provider_clearance (provider, jurisdiction, terms_version, cleared_by, expires_at, revoked_at)
         VALUES ('revoked','IN','v1','seat-10', now() + interval '1 year', now())`);
      await fixture.pool.query(
        `INSERT INTO provider_clearance (provider, jurisdiction, terms_version, cleared_by, cleared_at, expires_at)
         VALUES ('expired','IN','v1','seat-10', now() - interval '2 years', now() - interval '1 day')`);
      const r = await readClearance(fixture.pool, ['IN']);
      expect(r.cleared.size).toBe(0);
    } finally { await fixture.close(); }
  }, 120_000);

  it('maps GB to the schema\'s UK, so a clearance row can actually match', () => {
    // contracts says GB (the ISO code); the schema says UK (what the law is
    // called). A silent mismatch means a clearance row that never matches.
    expect(toJurisdiction('GB')).toBe('UK');
    expect(toJurisdiction('IN')).toBe('IN');
  });
});

// ---------------------------------------------------------------------------
// Usage reporting. Added for phase 1 of docs/chittu-model-plan.md.
// ---------------------------------------------------------------------------
describe('the router reports what a call cost, and nothing about who made it', () => {
  it('reports provider, model, prompt version, tokens and latency', async () => {
    const seen: ModelUsage[] = [];
    const r = router();
    await r.classify('hello', [], { band: 'builder', country: 'IN' }, (u) => seen.push(u));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      category: 'classifier',
      provider: 'anthropic',
      model: DEFAULT_CELLS.classifier.model,
      promptVersion: DEFAULT_CELLS.classifier.promptVersion,
    });
    expect(seen[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('carries NO session, child or text — the router never learns them', async () => {
    const seen: ModelUsage[] = [];
    const r = router();
    await r.generate({ text: 'a very distinctive sentence about my dog Rusty',
      state: state(), subject: null }, (u) => seen.push(u));
    const serialised = JSON.stringify(seen);
    expect(serialised).not.toMatch(/Rusty|distinctive|session|child/i);
    expect(Object.keys(seen[0]!).sort()).toEqual(
      ['category', 'latencyMs', 'model', 'promptVersion', 'provider', 'tokensIn', 'tokensOut']);
  });

  it('reports nothing when no call is made — a refused route costs nothing', async () => {
    const seen: ModelUsage[] = [];
    const r = router({ cleared: new Set<string>() });
    await r.classify('hello', [], undefined, (u) => seen.push(u)).catch(() => {});
    expect(seen).toHaveLength(0);
  });

  it('is optional — every existing caller still works without it', async () => {
    const r = router();
    await expect(r.classify('hello', [])).resolves.toBeDefined();
  });
});
