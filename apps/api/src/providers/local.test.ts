/**
 * The second provider, driven over real HTTP against a local stub.
 *
 * These are `tests/local-provider.spec.js` brought across from the prototype,
 * which has had this path since v3 and twelve Playwright tests behind it. The
 * port carried the Anthropic branch and left this one — so what is being
 * verified is a claim phase 3 exists to make: everything above `route()` is
 * provider-blind, and a genuinely different wire proves it in a way a second
 * Anthropic model never could.
 *
 *                 Anthropic                     here
 *   path          /v1/messages                  /chat/completions
 *   system        a top-level field             folded into messages[0]
 *   reply         content[] blocks, typed       choices[0].message.content
 *
 * The shape assertions matter more than they look. Sending Anthropic's body to
 * this endpoint produces a model that never saw its own system prompt — no
 * error, no 400, just a model behaving as though the fifteen hard rules were
 * never written. That reads as a bad model rather than a bad request, and it is
 * exactly the failure a second provider exists to make visible.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localAdapter, LOCAL_ID } from './local.js';
import { ProviderError } from './anthropic.js';
import { createRouter, DEFAULT_CELLS } from './router.js';
import { runTurn, type SessionState } from '@chittu/pipeline';
import { createChain } from '@chittu/seal';
import { MODEL_CATALOGUE } from './cells.js';
import { RATES } from './rates.js';

let server: Server;
let baseUrl: string;
let recorded: { headers: Record<string, string>; body: any; url: string }[] = [];
let respond: (n: number) => { status: number; body: unknown; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      recorded.push({
        headers: req.headers as Record<string, string>,
        body: raw === '' ? null : JSON.parse(raw),
        url: req.url ?? '',
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** The OpenAI reply envelope, which is not Anthropic's. */
const chat = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }) => ({
  choices: [{ message: { role: 'assistant', content } }],
  ...(usage ? { usage } : {}),
});

beforeEach(() => {
  recorded = [];
  respond = () => ({ status: 200, body: chat('{"label":"SAFE","memory":null,"assist":null}') });
});

const adapter = (over: Partial<Parameters<typeof localAdapter>[0]> = {}) =>
  localAdapter({ baseUrl, sleep: async () => {}, ...over });

const cells = {
  ...DEFAULT_CELLS,
  classifier: { ...DEFAULT_CELLS.classifier, provider: 'local', model: 'chittu-baseline' },
  sandbox: { ...DEFAULT_CELLS.sandbox, provider: 'local', model: 'chittu-baseline' },
};

const router = () => createRouter({ adapters: { local: adapter() }, cells });

const state = (over: Partial<SessionState> = {}): SessionState => ({
  kid: 'Meera', band: 'builder', country: 'IN', board: 'CBSE', mode: 'chat',
  crisisLock: false, memOn: true, memories: [], mathPractice: null,
  history: [], recentKid: [], spineCount: 0, flags: [], topics: [], assists: [],
  lastSubject: null, ...over,
} as SessionState);

// ---------------------------------------------------------------------------

describe('the wire is OpenAI-shaped, not Anthropic-shaped', () => {
  it('posts to /chat/completions', async () => {
    await router().classify('hello', []);
    expect(recorded[0]!.url).toBe('/v1/chat/completions');
  });

  it('folds the system prompt into messages[0], with no top-level system', async () => {
    await router().generate({ text: 'why is the sky blue', state: state(), subject: 'science', grounding: null });
    const body = recorded[0]!.body;
    expect(body.system, 'a top-level system field is Anthropic\'s shape').toBeUndefined();
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/The child is 8-12/);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'why is the sky blue' });
  });

  it('reads the reply from choices[0].message.content', async () => {
    respond = () => ({ status: 200, body: chat('Sunlight scatters blue light!') });
    const out = await router().generate({ text: 'why', state: state(), subject: null, grounding: null });
    expect(out).toBe('Sunlight scatters blue light!');
  });

  it('sends no authorization header when there is no key — most local servers have none',
    async () => {
      await router().classify('hello', []);
      expect(recorded[0]!.headers['authorization']).toBeUndefined();
    });

  it('sends a bearer when one is configured, and never in the body', async () => {
    const r = createRouter({
      adapters: { local: adapter({ apiKey: 'local-secret-not-real' }) }, cells });
    await r.classify('hello', []);
    expect(recorded[0]!.headers['authorization']).toBe('Bearer local-secret-not-real');
    expect(JSON.stringify(recorded[0]!.body)).not.toContain('local-secret-not-real');
  });
});

describe('the guards still stand around a different engine', () => {
  const drive = async (vendorReply: string, text = 'everything feels like a lot') => {
    const r = router();
    respond = (n) => n === 0
      ? { status: 200, body: chat('{"label":"SAFE","memory":null,"assist":null}') }
      : { status: 200, body: chat(vendorReply) };
    const ports = {
      classify: (t: string, k: readonly string[], c: never) => r.classify(t, k, c),
      generate: (i: Parameters<typeof r.generate>[0]) => r.generate(i),
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    const out = await runTurn(state(), text, ports as never);
    const shown = out.response.blocks.map((b) =>
      b.kind === 'chips' ? b.chips.join(' ')
        : b.kind === 'steps' ? b.items.join(' ')
          : b.kind === 'big' ? b.emoji : b.text).join(' ');
    return { lock: out.response.crisisLock, trace: out.response.trace, shown, calls: recorded };
  };

  /**
   * THE ONE THIS ADAPTER EXISTS FOR. A fine-tuned Qwen3 emits `<think>…</think>`
   * as an artefact of the chat template it was trained with, so on this engine
   * the reasoning preamble is the ORDINARY case rather than an edge one — and
   * the pipeline compares escalation tokens with `===`.
   */
  it.each(['CRISIS', 'SPINE', 'UNSAFE', 'PII'])(
    '"<think></think>%s" from a local model still triggers the guard', async (token) => {
      const out = await drive(`<think>the child is describing self-harm</think>${token}`);
      expect(out.trace, 'the escalation token did not fire').toMatch(/scripted|SPINE|CRISIS/);
      expect(out.shown).not.toMatch(/describing self-harm/);
    });

  it('a think block with reasoning inside is stripped, the answer preserved', async () => {
    const out = await drive(
      '<think>should I say i love you? no</think>Volcanoes erupt when magma rises!',
      'why do volcanoes erupt');
    expect(out.shown).toContain('Volcanoes erupt when magma rises!');
    expect(out.shown).not.toMatch(/i love you|should I say/);
  });

  it('the classifier still parses JSON through the local path', async () => {
    respond = () => ({ status: 200, body: chat('{"label":"CRISIS","memory":null,"assist":null}') });
    const out = await router().classify('i want to disappear', []);
    expect(out.label).toBe('CRISIS');
  });

  it('a classifier reply this parser does not understand still THROWS', async () => {
    // "The classifier never invents a SAFE" holds on every engine.
    respond = () => ({ status: 200, body: chat('probably fine') });
    await expect(router().classify('hello', [])).rejects.toThrow();
  });

  it('L1 still precedes the local model — a crisis phrase reaches no endpoint', async () => {
    const out = await drive('should never be called', 'i want to hurt myself');
    expect(out.lock).toBe(true);
    expect(recorded, 'a crisis turn reached the endpoint').toHaveLength(0);
  });

  it('arithmetic still bypasses the model entirely', async () => {
    await drive('should never be called', 'what is 7 times 8');
    expect(recorded).toHaveLength(0);
  });

  it('L6 still filters local output', async () => {
    const out = await drive('I will always miss you when you go', 'do you think about me');
    expect(out.trace).toBe('OUTPUT FILTER (L6) · blocked');
    expect(out.shown).not.toMatch(/miss you/);
  });
});

describe('failure handling matches the other adapter, because the port is one contract', () => {
  it('retries a 429 once and succeeds', async () => {
    respond = (n) => n === 0
      ? { status: 429, body: { error: { message: 'busy' } } }
      : { status: 200, body: chat('Answer') };
    expect(await router().generate({ text: 'why', state: state(), subject: null, grounding: null }))
      .toBe('Answer');
    expect(recorded).toHaveLength(2);
  });

  it('does NOT retry a 400', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad model' } } });
    await expect(router().generate({ text: 'why', state: state(), subject: null, grounding: null }))
      .rejects.toThrow(/400/);
    expect(recorded).toHaveLength(1);
  });

  it('times out rather than hanging a child\'s turn, and names the endpoint', async () => {
    respond = () => ({ status: 200, body: chat('slow'), delayMs: 120 });
    const r = createRouter({ adapters: { local: adapter({ timeoutMs: 20 }) }, cells });
    await expect(r.generate({ text: 'why', state: state(), subject: null, grounding: null }))
      .rejects.toThrow(/timed out.*127\.0\.0\.1/);
  });

  it('treats an empty completion as a failure, not as silence', async () => {
    respond = () => ({ status: 200, body: chat('') });
    await expect(router().generate({ text: 'why', state: state(), subject: null, grounding: null }))
      .rejects.toThrow(/empty completion/);
  });

  it('never puts the child\'s words into the error message', async () => {
    respond = () => ({ status: 400, body: { error: { message: 'bad request' } } });
    const err = await router().generate({
      text: 'my secret is bananabread', state: state(), subject: null, grounding: null,
    }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('bananabread');
    expect(String((err as Error).stack ?? '')).not.toContain('bananabread');
  });

  it('says the endpoint is down rather than "fetch failed"', async () => {
    // The commonest failure on this lane by a wide margin, and `fetch failed`
    // on its own sends people to look in the wrong place.
    const r = createRouter({
      adapters: { local: localAdapter({ baseUrl: 'http://127.0.0.1:1/v1', sleep: async () => {} }) },
      cells });
    const err = await r.generate({ text: 'why', state: state(), subject: null, grounding: null })
      .catch((e: unknown) => e);
    expect((err as ProviderError).provider).toBe(LOCAL_ID);
    expect(String((err as Error).message)).toMatch(/127\.0\.0\.1:1/);
  });
});

describe('metering reports what the endpoint said, and nothing when it said nothing', () => {
  it('reports OpenAI-named token counts', async () => {
    respond = () => ({ status: 200, body:
      chat('Answer', { prompt_tokens: 137, completion_tokens: 29 }) });
    const usage: { tokensIn: number; tokensOut: number; provider: string }[] = [];
    await router().generate({ text: 'why', state: state(), subject: null, grounding: null },
      (u) => usage.push(u));
    // Distinct primes, so a transposition cannot pass.
    expect(usage[0]).toMatchObject({ provider: 'local', tokensIn: 137, tokensOut: 29 });
  });

  it('leaves the counts ABSENT when the endpoint omits them, rather than zero', async () => {
    // Asserted on the ADAPTER, not through the router — the router fills `?? 0`
    // for an absent count, so through it "the server said nothing" and "the
    // server said zero" are the same value. They are not the same fact: a zero
    // is priced, stamped with a real rate version, and read on the ops console
    // as a call that cost nothing rather than one nobody counted.
    respond = () => ({ status: 200, body: chat('Answer') });
    const reply = await adapter().complete(
      { system: 's', messages: [{ role: 'user', content: 'hi' }] },
      { provider: 'local', model: 'chittu-baseline', promptVersion: 'v' });
    expect('tokensIn' in reply, 'an absent count was reported as a number').toBe(false);
    expect('tokensOut' in reply).toBe(false);
  });
});

describe('the catalogue and the price list agree with each other', () => {
  it('every local model this build may route to is priced', () => {
    for (const model of MODEL_CATALOGUE['local'] ?? []) {
      expect(RATES['local']?.[model], `${model} has no rate`).toBeDefined();
    }
  });

  it('names only models this repository can actually serve', () => {
    // `llm-kit/Modelfile.chittu` and `Modelfile.chittu-8b` build the first two;
    // `llm-kit/train.sh` produces the third. A catalogue entry for a model
    // nobody here can start is a cell that refuses at runtime.
    //
    // `mxbai-embed-large` is the odd one out: it is PULLED (`ollama pull
    // mxbai-embed-large`, documented in .env.example) rather than built here,
    // and it answers no child — it embeds their turn for corpus retrieval. It
    // earns its place by the same test as the others, which is whether someone
    // following this repository can actually start it.
    expect([...(MODEL_CATALOGUE['local'] ?? [])].sort()).toEqual([
      'chittu-baseline', 'chittu-baseline-8b',
      'mlx-community/Qwen3-4B-Instruct-2507-4bit',
      'mxbai-embed-large',
    ]);
  });
});
