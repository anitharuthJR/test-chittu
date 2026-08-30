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
import { runTurn, type SessionState } from '@chittu/pipeline';
import { createChain } from '@chittu/seal';
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
      /**
       * `embedding` is the exception, and it is the only one: it names `local`,
       * because Anthropic has no embeddings API for it to name. With only the
       * Anthropic adapter configured — which is this router — routing it is
       * REFUSED rather than falling back to a reachable cell.
       *
       * That refusal is what turns the grounded corpus off in an
       * Anthropic-only deployment, and off is a supported state: no CORPUS
       * layer is stamped and answers come from the truth wall. It is
       * deliberately NOT a boot refusal (see main.ts) — an unreachable
       * enrichment must not stop a service that can still guard every turn.
       */
      if (category === 'embedding') {
        expect(DEFAULT_CELLS.embedding.provider).toBe('local');
        expect(() => r.route(category)).toThrow(RouteRefused);
        continue;
      }
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
    await expect(r.generate({ text: 'hello', state: state(), subject: null, grounding: null }))
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
    await r.generate({ text: 'hi', state: state({ country: 'GB' }), subject: null, grounding: null });
    expect(recorded[0]!.body.model).toBe('claude-opus-5');
    await r.generate({ text: 'hi', state: state({ country: 'IN' }), subject: null, grounding: null });
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
    await r.generate({ text: 'help', state: state({ mode: 'homework' }), subject: null, grounding: null });
    expect(recorded[0]!.body.model).toBe(DEFAULT_CELLS.homework.model);
    await r.generate({ text: 'why', state: state({ mode: 'learn' }), subject: null, grounding: null });
    expect(recorded[1]!.body.model).toBe(DEFAULT_CELLS.curriculum.model);
  });
});

/**
 * The `vision` cell has existed in §12.2 since the routing table was written
 * and nothing ever asked for it — configured and unreachable, which reads as a
 * working capability in review and is not one.
 */
describe('the VISION cell, and the only thing that reaches it', () => {
  const picture = { mimeType: 'image/png' as const, dataBase64: 'aW1hZ2V6enpieXRlcw' };

  it('a turn with a picture routes to the vision cell', async () => {
    const r = router({
      scopedCells: resolveCells({
        rows: [{ category: 'vision', provider: 'anthropic', model: 'claude-opus-5' }],
      }),
    });
    await r.generate({ text: 'what is this?', state: state(), subject: null, grounding: null,
      image: picture });
    expect(recorded[0]!.body.model).toBe('claude-opus-5');
  });

  it('a turn WITHOUT one does not — the cell is not a new default', async () => {
    const r = router({
      scopedCells: resolveCells({
        rows: [{ category: 'vision', provider: 'anthropic', model: 'claude-opus-5' }],
      }),
    });
    await r.generate({ text: 'why is the sky blue', state: state(), subject: null, grounding: null });
    expect(recorded[0]!.body.model).toBe(DEFAULT_CELLS.sandbox.model);
  });

  it('the picture WINS over the mode — a photo of a worksheet still needs eyes', async () => {
    // The mode still shapes the prompt; it is only the cell that changes.
    const r = router({
      scopedCells: resolveCells({
        rows: [{ category: 'vision', provider: 'anthropic', model: 'claude-opus-5' },
          { category: 'homework', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
      }),
    });
    await r.generate({ text: 'is this right?', state: state({ mode: 'homework' }),
      subject: null, grounding: null, image: picture });
    expect(recorded[0]!.body.model).toBe('claude-opus-5');
    expect(recorded[0]!.body.system).toMatch(/HOMEWORK MODE/);
  });

  it('meters as a vision call, not as a sandbox one', async () => {
    const seen: string[] = [];
    await router().generate(
      { text: 'what is this?', state: state(), subject: null, grounding: null, image: picture },
      (u) => seen.push(u.category));
    expect(seen).toEqual(['vision']);
  });

  it('is refused when the vision provider is not cleared for this child\'s country', async () => {
    const r = router({
      clearedByCountry: new Map([['anthropic', new Set(['IN'])]]),
    });
    await expect(r.generate({ text: 'what is this?', state: state({ country: 'GB' }),
      subject: null, grounding: null, image: picture })).rejects.toThrow(RouteRefused);
    expect(recorded, 'a refused route still sent the picture').toEqual([]);
  });

  it('puts the image on the wire ahead of the text, and only on the last user turn', async () => {
    // Anthropic's shape. A model that reads "is my drawing good?" before it has
    // seen the drawing answers a different question.
    await router().generate({
      text: 'is my drawing good?',
      state: state({ history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'is my drawing good?' },
      ] }),
      subject: null, grounding: null, image: picture,
    });
    const messages = recorded[0]!.body.messages as {
      role: string; content: string | { type: string; text?: string;
        source?: { media_type: string; data: string } }[];
    }[];
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content, 'an earlier turn was rewritten').toBe('hello');
    const last = messages[2]!.content as { type: string; text?: string;
      source?: { media_type: string; data: string } }[];
    expect(last[0]!.type).toBe('image');
    expect(last[0]!.source).toEqual({
      type: 'base64', media_type: 'image/png', data: picture.dataBase64 });
    expect(last[1]).toEqual({ type: 'text', text: 'is my drawing good?' });
  });

  it('a text turn sends plain string content, exactly as before', async () => {
    await router().generate({ text: 'hello', state: state(), subject: null, grounding: null });
    expect(recorded[0]!.body.messages.at(-1).content).toBe('hello');
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
    // The port takes the child's OWN turns. Chittu's replies are not in the
    // array at all — they used to be, and the router filtered them out, which
    // made the filter look like the thing keeping them out rather than an
    // accident of one array serving two jobs.
    await router().classify('and now this one', ['first', 'second']);
    const body = recorded[0]!.body;
    expect(body.system).toMatch(/safety\+memory classifier/);
    expect(body.messages[0].content).toBe(
      '[msg 1] first\n[msg 2] second\n[msg 3] and now this one');
  });

  it('sends the sandbox prompt with the band, board and child name', async () => {
    await router().generate({
      text: 'why is the sky blue',
      state: state({ band: 'explorer', board: 'TN', kid: 'Arjun' }),
      subject: 'science', grounding: null,
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
      text: 'hi', state: state({ memOn: false, memories }), subject: null, grounding: null });
    expect(recorded[0]!.body.system).not.toMatch(/Mani/);

    await router().generate({
      text: 'hi', state: state({ memOn: true, memories }), subject: null, grounding: null });
    expect(recorded[1]!.body.system).toMatch(/Mani/);
  });
});

describe('the classifier never invents a SAFE', () => {
  it('parses a well-formed CRISIS', async () => {
    respond = () => ({ status: 200, body: text('{"label":"CRISIS","memory":null,"assist":null}') });
    expect((await router().classify('x', [])).label).toBe('CRISIS');
  });

  /**
   * CHANGED 2026-08-29. This asserted that IDENTITY and SECRET both became
   * `SPINE`, which is what the code did and what the comment beside it
   * justified: "which one it was decides the scripted reply, and that decision
   * already happened at L1."
   *
   * It had not. L2 only runs when L1 did NOT catch the turn, so the
   * justification described the one case that cannot occur — and downstream a
   * fall-through gave both the IDENTITY spine. A child asking "will it stay
   * between us forever", which L1's lexicon misses, was answered with "I'm a
   * computer program … I don't feel love or miss people" and raised no
   * SECRET_KEEPING flag. The test pinned it as correct for as long as it
   * existed.
   */
  it('does NOT collapse IDENTITY and SECRET — see the seam test below', async () => {
    for (const l of ['IDENTITY', 'SECRET']) {
      respond = () => ({ status: 200, body: text(`{"label":"${l}"}`) });
      expect((await router().classify('x', [])).label).toBe(l);
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
    await expect(router().generate({ text: 'hi', state: state(), subject: null, grounding: null }))
      .rejects.toThrow(/empty completion/);
  });

  it('never puts the child\'s words into the error message', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    try {
      await router().generate({
        text: 'my secret is that i live at 4 Elm Street', state: state(), subject: null, grounding: null });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Elm Street/);
    }
  });
});

/*
 * REMOVED: `the vendor's own litter is stripped before the pipeline sees it`.
 *
 * It asserted `expect(out).toBe('plan Sunlight scatters blue!')` on the input
 * `<think>plan</think>Sunlight scatters blue!<|end|>` — pinning the model's
 * reasoning surviving into the answer as the INTENDED result, and explaining in
 * a comment why that was acceptable. It was not: the same path welds reasoning
 * onto an escalation token and stops it matching.
 *
 * Superseded by `reasoning must not survive into the escalation comparison`
 * below, which asserts the correct output for that exact input.
 */

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
      state: state(), subject: null, grounding: null }, (u) => seen.push(u));
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

// ---------------------------------------------------------------------------

describe('the child is asked ONCE — the pipeline\'s history already holds the turn', () => {
  /**
   * The two tests in "the request we actually send" above build `history`
   * WITHOUT the current turn, which is the convention the router assumed. The
   * pipeline supplies the opposite: `runTurn` appends the child's turn to
   * `history` before any port is called, so by the time `generate()` and
   * `classify()` run, the turn is already the last entry.
   *
   * That mismatch is invisible from either side. The router tests were green
   * because their fixture matched the router; the pipeline tests were green
   * because they count model calls rather than inspect bodies; and every
   * SessionState fixture in this repo starts with `history: []`, so turn one —
   * the only turn a smoke test drives — looks identical either way.
   *
   * The seam test below drives the real pipeline into the real router, which is
   * the only place the two conventions meet.
   */
  it('sends the sandbox the turn once, not twice', async () => {
    await router().generate({
      text: 'second question',
      state: state({
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'a reply' },
          { role: 'user', content: 'second question' },
        ],
      }),
      subject: null, grounding: null,
    });
    const msgs = recorded[0]!.body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.content)).toEqual(
      ['first question', 'a reply', 'second question']);
    // Two adjacent user messages is also what makes this vendor-specific: some
    // vendors merge them, some reject the request outright.
    expect(msgs.filter((m, i) => i > 0 && m.role === msgs[i - 1]!.role)).toEqual([]);
  });

  it('gives the classifier three DISTINCT turns, not the latest one twice', async () => {
    // The window exists to show patterns across messages — escalating secrecy,
    // repeated distress. Feeding the current turn twice makes every turn look
    // like a repeat to the one layer whose job is noticing repeats, and costs a
    // real turn of context out of a three-turn window.
    await router().classify('third', ['first', 'second', 'third']);
    expect(recorded[0]!.body.messages[0].content).toBe(
      '[msg 1] first\n[msg 2] second\n[msg 3] third');
  });

  it('still appends when the caller passes history WITHOUT the turn', async () => {
    // Both conventions have to work: `route()` is a public port and an ops
    // command or a future caller may hold either. The router decides from what
    // it was actually given rather than from what it assumes.
    await router().generate({
      text: 'only question',
      state: state({ history: [], recentKid: [] }),
      subject: null, grounding: null,
    });
    expect((recorded[0]!.body.messages as { content: string }[]).map((m) => m.content))
      .toEqual(['only question']);
  });
});

describe('reasoning must not survive into the escalation comparison', () => {
  /**
   * `stripControlTokens` in the kernel SLICES at the last `</think>` and keeps
   * what follows. The adapter used to replace `<think>` and `</think>` with
   * spaces first — which deletes the delimiter the kernel needs, so the slice
   * never happened and the reasoning was welded onto the answer.
   *
   * On an ordinary turn that is a cosmetic leak. On the turn that matters it is
   * not: the sandbox's escalation tokens are compared EXACTLY, so
   * `<think>…</think>CRISIS` arrived as `… CRISIS`, matched nothing, and the
   * model's reasoning about a child's self-harm would have been rendered to her
   * with no crisis lock, no helplines and no parent flag. L6 does not catch it
   * — it tests for banned content, and reasoning is not banned content.
   *
   * THESE ASSERT THROUGH THE PIPELINE, not against `router.generate()`. The
   * kernel's slice lives in the pipeline and applies to the sandbox reply and
   * to nothing else — which is the point of the fix, so a router-level
   * assertion would be checking the wrong half of the chain.
   */
  const drive = async (vendorReply: string) => {
    const r = router();
    respond = (n) => n === 0
      ? { status: 200, body: text('{"label":"SAFE","memory":null,"assist":null}') }
      : { status: 200, body: text(vendorReply) };
    const p = {
      classify: (t: string, k: readonly string[], c: never) => r.classify(t, k, c),
      generate: (i: Parameters<typeof r.generate>[0]) => r.generate(i),
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    const out = await runTurn(state({ history: [], recentKid: [] }), 'everything feels like a lot', p as never);
    const shown = out.response.blocks.map((b) =>
      b.kind === 'chips' ? b.chips.join(' ')
        : b.kind === 'steps' ? b.items.join(' ')
          : b.kind === 'big' ? b.emoji : b.text).join(' ');
    return { lock: out.response.crisisLock, trace: out.response.trace, shown };
  };

  it('an escalation token behind a reasoning preamble still locks the chat', async () => {
    const out = await drive('<think>she said she wants to die</think>CRISIS');
    expect(out.lock, 'the crisis token did not fire').toBe(true);
    expect(out.shown, "the model's reasoning was rendered to the child")
      .not.toMatch(/she said she wants to die/);
  });

  it('drops reasoning from an ordinary answer rather than welding it on', async () => {
    const out = await drive('<think>plan the answer</think>Sunlight scatters blue!<|end|>');
    expect(out.shown).toContain('Sunlight scatters blue!');
    expect(out.shown).not.toMatch(/plan the answer|<\||<think>/);
  });

  it('a reply that is ONLY reasoning never reaches the child', async () => {
    const out = await drive('<think>thinking about it</think>');
    expect(out.shown).not.toMatch(/thinking about it/);
  });
});

describe('the CLASSIFIER reply is JSON, and must NOT be sliced', () => {
  /**
   * The first version of this fix moved `stripControlTokens` into the router's
   * `callAdapter`, so it ran for every category. That broke the classifier and
   * lost a crisis `main` catches: a verdict carrying the literal characters
   * `</think>` inside a string value is cut in half by the slice, fails
   * `parseClassifier`, and the pipeline honestly reports FAST-PATH-ONLY — an
   * ordinary chat where the chat should have locked.
   *
   * "i want to disappear" does not trip L1. On that turn L2 is the only wall.
   * The slice is right for prose and wrong for JSON, so it stays on the path
   * that carries prose.
   */
  it('a verdict containing </think> in a string value still parses', async () => {
    respond = () => ({ status: 200, body: text(
      '{"label":"CRISIS","memory":null,"assist":"STRUGGLE: pasted </think> at school"}') });
    const out = await router().classify('i want to disappear', []);
    expect(out.label).toBe('CRISIS');
  });

  it('and one carrying a special token in a memory does too', async () => {
    respond = () => ({ status: 200, body: text(
      '{"label":"SAFE","memory":{"category":"PET","fact":"a cat called <|mani|>"},"assist":null}') });
    const out = await router().classify('my cat', []);
    expect(out.label).toBe('SAFE');
  });
});

/*
 * REMOVED: `controlTokens is a port member that has to DO something`.
 *
 * It is not one, and the attempt to make it one was withdrawn. Applying it in
 * `callAdapter` as a DELETE, after the kernel's slice, recreated the exact
 * defect this change fixes — for any vendor whose reasoning delimiters are not
 * `<think>`. The router would find no `</think>` to slice on, then delete the
 * vendor's own delimiters, and weld the reasoning back onto the answer.
 *
 * The field cannot express the difference between a DELIMITER (slice, keep what
 * follows) and LITTER (delete). Fixing that is a contract change; it is recorded
 * in PORT-REVIEW as a known-dead port member rather than papered over with a
 * live one that is wrong.
 */

describe('an error reports what the adapter actually did', () => {
  it('a failure the retry loop declined to retry is not marked retryable', async () => {
    // `retryable` was hardcoded `true` on the escaping error, including for
    // failures the loop had just refused to retry. Nothing reads it today,
    // which is why it went unnoticed — and §12.3's promised
    // fall-back-to-a-cleared-cell policy is exactly what would read it.
    const a = anthropicAdapter({
      apiKey: 'k', baseUrl, sleep: async () => {},
      fetchImpl: (() => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
    });
    const err = await a.complete(
      { system: 's', messages: [{ role: 'user', content: 'hi' }] },
      { provider: 'anthropic', model: 'm', promptVersion: 'v' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it('a timeout that exhausted the budget still is', async () => {
    respond = () => ({ status: 200, body: text('ok'), delayMs: 60 });
    const a = anthropicAdapter({ apiKey: 'k', baseUrl, timeoutMs: 20, sleep: async () => {} });
    const err = await a.complete(
      { system: 's', messages: [{ role: 'user', content: 'hi' }] },
      { provider: 'anthropic', model: 'm', promptVersion: 'v' },
    ).catch((e: unknown) => e);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe('a child repeating themselves — the case the window exists for', () => {
  /**
   * CLASSIFIER_SYSTEM asks the model to judge the latest message in context
   * because "patterns across messages matter: escalating secrecy,
   * boundary-testing, repeated distress". So a conditional append is only
   * correct if REAL repetition still reaches it.
   *
   * It does, and the old code was worse than a double-send: it showed a
   * repetition on the very first turn a child ever sent, because it appended
   * `text` to a history that already ended with it. Every turn looked like a
   * repeat to the one layer that escalates on repeats.
   *
   *   turn 1, old:  [msg 1] i feel awful | [msg 2] i feel awful
   *   turn 1, new:  [msg 1] i feel awful
   */
  const say = async (r: ReturnType<typeof router>, turns: readonly string[]) => {
    let s = state({ history: [], recentKid: [] });
    const p = {
      classify: (t: string, k: readonly string[], c: never) => r.classify(t, k, c),
      generate: (i: Parameters<typeof r.generate>[0]) => r.generate(i),
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    for (const t of turns) s = (await runTurn(s, t, p as never)).state;
    return recorded.filter((x) => (x.body.system as string).includes('safety+memory classifier'))
      .map((x) => x.body.messages[0].content as string);
  };

  it('shows one turn for one turn, and two for two', async () => {
    const windows = await say(router(), ['i feel awful', 'i feel awful']);
    expect(windows[0]).toBe('[msg 1] i feel awful');
    expect(windows[1]).toBe('[msg 1] i feel awful\n[msg 2] i feel awful');
  });

  it('shows three for three — genuine escalating distress is not swallowed', async () => {
    const windows = await say(router(), ['i feel awful', 'i feel awful', 'i feel awful']);
    expect(windows[2]).toBe(
      '[msg 1] i feel awful\n[msg 2] i feel awful\n[msg 3] i feel awful');
  });
});
describe('the convention this all rests on', () => {
  /**
   * The router appends the turn only when what it was given does not already
   * end with it. That is correct because `runTurn` always puts it there first —
   * and if that stopped being true the router would silently under-count a
   * verbatim repeat rather than fail. So the convention is pinned at the
   * pipeline, not assumed in the router.
   *
   * The two ports get DIFFERENT arrays now, and that separation IS the fix:
   * `classify` gets the child's own turns, `generate` gets the model's context
   * with this turn appended as a candidate. One array serving both is what let
   * an L6 block delete a turn from the classifier's window, and what sent a
   * turn L1 had refused to a vendor on the following turn.
   */
  it('hands the classifier a window ending with the current turn', async () => {
    const seen: { text: string; last: string | undefined }[] = [];
    const ports = {
      async classify(text: string, recentKid: readonly string[]) {
        seen.push({ text, last: recentKid.at(-1) });
        return { label: 'SAFE' as const, memory: null, assist: null };
      },
      async generate() { return 'a reply'; },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    const t1 = await runTurn(state({ history: [], recentKid: [] }), 'first', ports as never);
    await runTurn(t1.state, 'second', ports as never);
    expect(seen).toEqual([
      { text: 'first', last: 'first' },
      { text: 'second', last: 'second' },
    ]);
  });

  it('hands the sandbox a context ending with the current turn', async () => {
    const seen: { text: string; last: string | undefined; role: string | undefined }[] = [];
    const ports = {
      async classify() { return { label: 'SAFE' as const, memory: null, assist: null }; },
      async generate(input: { text: string; state: SessionState }) {
        const last = input.state.history.at(-1);
        seen.push({ text: input.text, last: last?.content, role: last?.role });
        return 'a reply';
      },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    const t1 = await runTurn(state({ history: [], recentKid: [] }), 'first', ports as never);
    await runTurn(t1.state, 'second', ports as never);
    expect(seen).toHaveLength(2);
    for (const x of seen) {
      expect(x.last, `the sandbox context ended with ${x.last}`).toBe(x.text);
      expect(x.role).toBe('user');
    }
  });

  it("starts the model's context with a user turn, and keeps it alternating", async () => {
    // An L6 block used to leave `history` beginning with the scripted fallback
    // and no user turn in front of it, for the rest of the session. Anthropic
    // requires the first message to be `user`, so every later turn in that
    // session would have failed — permanently, since the leading assistant
    // message never left.
    const roles: string[][] = [];
    const ports = {
      async classify() { return { label: 'SAFE' as const, memory: null, assist: null }; },
      async generate(input: { state: SessionState }) {
        roles.push(input.state.history.map((m) => m.role));
        return roles.length === 1 ? 'I will always miss you when you go' : 'a fine answer';
      },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    let s = state({ history: [], recentKid: [] });
    for (const t of ['first', 'second', 'third']) {
      s = (await runTurn(s, t, ports as never)).state;
    }
    expect(roles).toHaveLength(3);
    for (const seq of roles) {
      expect(seq[0], `the context began with ${seq[0]}`).toBe('user');
      expect(seq.filter((r, i) => i > 0 && r === seq[i - 1]),
        `two adjacent messages shared a role: ${seq.join(',')}`).toEqual([]);
    }
  });
});

describe('the classifier label reaches the pipeline UNCOLLAPSED', () => {
  /**
   * This mapped IDENTITY and SECRET both onto `SPINE`, and the pipeline's
   * fall-through then gave both the identity spine — so a child asking
   * something L1's lexicon misses got "I'm a computer program" instead of the
   * no-secrets script, and no parent flag.
   *
   * The pipeline tests construct labels directly and never cross this seam, so
   * re-collapsing here broke nothing at all until this test existed. Same shape
   * as PR #41: both ends tested, the wire between them not.
   */
  it.each(['SECRET', 'IDENTITY', 'OVERRIDE', 'CRISIS', 'PII', 'UNSAFE', 'SAFE'])(
    'passes %s through as itself', async (label) => {
      respond = () => ({ status: 200, body:
        text(`{"label":"${label}","memory":null,"assist":null}`) });
      const out = await router().classify('some turn', []);
      expect(out.label, `${label} was rewritten on the way to the pipeline`).toBe(label);
    });
});
