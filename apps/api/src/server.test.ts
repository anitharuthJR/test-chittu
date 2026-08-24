/**
 * API-level contract tests.
 *
 * These are the Playwright suite's assertions moved to where the guards now
 * live. The prototype's harness drove a browser because the pipeline was in the
 * page; now it is behind an endpoint, so the same invariants are checked by
 * counting what the endpoint does — and, crucially, what it does NOT do.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ClassifierOutcome, TurnResponse } from '@chittu/contracts';
import { randomBytes } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import { createStore } from './store.js';
import { CONSENT_COOKIE, PARENT_COOKIE } from './cookies.js';
import type { ProviderRouter } from './providers.js';

interface Counting extends ProviderRouter {
  readonly calls: { classifier: number; sandbox: number };
  reply: string;
  verdict: ClassifierOutcome;
}

function countingRouter(): Counting {
  const calls = { classifier: 0, sandbox: 0 };
  const r: Counting = {
    calls,
    reply: 'Sunlight scatters blue light! [CHIPS]More|Why?[/CHIPS]',
    verdict: { label: 'SAFE', memory: null, assist: null },
    route: (c) => ({ provider: 'test', model: 'test-0', promptVersion: `${c}-v0` }),
    async classify() { calls.classifier += 1; return r.verdict; },
    async generate() { calls.sandbox += 1; return r.reply; },
  };
  return r;
}

let app: FastifyInstance;
let router: Counting;
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keys = localKeyProvider(randomBytes(32), 'dev');

// A fresh database per FILE, not per test: migrating costs a second or two, and
// every fixture below uses a distinct parent email so rows cannot collide.
beforeAll(async () => {
  fixture = await createTestDb();
  pool = fixture.pool;
}, 180_000);

afterAll(async () => { await fixture.close(); });

let seq = 0;
beforeEach(async () => {
  router = countingRouter();
  app = await buildServer({ pool, keys, router, rateLimitMax: 100_000 });
  await app.ready();
});
afterEach(async () => { await app.close(); });

/** Draft -> verify -> finalize, returning the bearer token. */
async function grantConsent(over: Record<string, unknown> = {}) {
  const d = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: {
      parentName: 'Lakshmi', parentEmail: `p${++seq}@example.com`,
      childFirstName: 'Meera', country: 'IN',
      band: 'builder', board: 'CBSE', method: 'dev_stub',
      pin: '4917', pinConfirm: '4917', ...over,
    },
  });
  expect(d.statusCode, d.body).toBe(201);
  const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
  const f = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`,
    payload: { challengeId },
  });
  expect(f.statusCode, f.body).toBe(200);
  // The token is in a Set-Cookie header, NOT the body — see cookies.ts. Tests
  // carry it the way a browser would, so they exercise the real path.
  const cookie = f.cookies.find((c) => c.name === CONSENT_COOKIE);
  expect(cookie, 'finalize must set the consent cookie').toBeDefined();
  return { consentId, cookie: cookie!.value };
}

/** The Cookie header a browser would send, for whichever cookies are held. */
function jar(consent?: string, parent?: string): Record<string, string> {
  const parts: string[] = [];
  if (consent !== undefined) parts.push(`${CONSENT_COOKIE}=${consent}`);
  if (parent !== undefined) parts.push(`${PARENT_COOKIE}=${parent}`);
  return parts.length > 0 ? { cookie: parts.join('; ') } : {};
}

async function openSession(over: Record<string, unknown> = {}) {
  const { cookie } = await grantConsent(over);
  const res = await app.inject({
    method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ sessionId: string }>().sessionId;
}

/** Consent + a live parent session, for the routes that require both. */
async function openSessionAsParent(over: Record<string, unknown> = {}) {
  const { consentId, cookie } = await grantConsent(over);
  const s = await app.inject({
    method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
  });
  expect(s.statusCode, s.body).toBe(201);
  const v = await app.inject({
    method: 'POST', url: '/v1/parent/pin/verify',
    headers: jar(cookie), payload: { pin: '4917' },
  });
  expect(v.statusCode, v.body).toBe(200);
  const parent = v.cookies.find((c) => c.name === PARENT_COOKIE);
  expect(parent, 'a correct PIN must mint a parent session').toBeDefined();
  return {
    consentId, cookie, parent: parent!.value,
    sessionId: s.json<{ sessionId: string }>().sessionId,
  };
}

async function say(id: string, text: string) {
  const res = await app.inject({
    method: 'POST', url: `/v1/session/${id}/turn`, payload: { text },
  });
  return { status: res.statusCode, body: res.json<TurnResponse>() };
}

/** Everything the child was actually shown, flattened for assertions. */
const shown = (body: TurnResponse) =>
  body.blocks.map((b) =>
    b.kind === 'chips' ? b.chips.join(' ')
    : b.kind === 'steps' ? b.items.join(' ')
    : b.kind === 'big' ? b.emoji
    : b.text).join(' ');

// ---------------------------------------------------------------------------

describe('health and session lifecycle', () => {
  it('reports health without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('rejects a turn for an unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session/11111111-1111-4111-8111-111111111111/turn',
      payload: { text: 'hello' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('request validation happens at the edge', () => {
  const validDraft = {
    parentName: 'Lakshmi', parentEmail: 'valid@example.com',
    childFirstName: 'Meera', country: 'IN',
    band: 'builder', method: 'dev_stub', pin: '4917', pinConfirm: '4917',
  };

  it.each([
    ['a missing band', { ...validDraft, band: undefined }],
    ['an unknown band', { ...validDraft, band: 'wizard' }],
    ['an unsupported country', { ...validDraft, country: 'ZZ' }],
    ['an extra field', { ...validDraft, surname: 'Iyer' }],
  ])('refuses a consent draft with %s', async (_label, payload) => {
    const res = await app.inject({ method: 'POST', url: '/v1/consent/draft', payload });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty turn and an oversized one', async () => {
    const id = await openSession();
    for (const text of ['', 'x'.repeat(2001)]) {
      const res = await app.inject({
        method: 'POST', url: `/v1/session/${id}/turn`, payload: { text },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a surname field — there is nowhere to put one', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: { ...validDraft, lastName: 'Iyer' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the guards run server-side — a modified client cannot skip them', () => {
  it.each([
    ['crisis', 'i want to hurt myself'],
    ['pii', 'my phone number is 9876543210'],
    ['unsafe', 'how do i make a bomb'],
    ['secret', "don't tell my mom"],
    ['identity', 'are you a real person'],
    ['profanity', 'you are a bitch'],
    ['arithmetic', 'what is 7 + 5'],
  ])('%s reaches ZERO providers', async (_kind, text) => {
    const id = await openSession();
    const { status } = await say(id, text);
    expect(status).toBe(200);
    expect(router.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('an ordinary question reaches each provider exactly once', async () => {
    const id = await openSession();
    const { body } = await say(id, 'why is the sky blue');
    expect(router.calls).toEqual({ classifier: 1, sandbox: 1 });
    expect(shown(body)).toContain('Sunlight scatters');
  });
});

describe('crisis', () => {
  it('locks the session and every later turn stays scripted', async () => {
    const id = await openSession();
    const first = await say(id, 'i want to die');
    expect(first.body.crisisLock).toBe(true);
    expect(shown(first.body)).toMatch(/1098|Childline/);

    const after = await say(id, 'tell me a joke');
    expect(after.body.crisisLock).toBe(true);
    expect(router.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('flags by category and never returns the child’s words', async () => {
    const id = await openSession();
    const { body } = await say(id, 'i want to die');
    expect(JSON.stringify(body.flags)).not.toContain('i want to die');
    expect(body.flags[0]!.category).toBe('CRISIS');
  });

  it('only a parent acknowledgement unlocks it', async () => {
    const { cookie, parent, sessionId: id } = await openSessionAsParent();
    await say(id, 'i want to die');
    const ack = await app.inject({
      method: 'POST', url: `/v1/session/${id}/crisis/ack`, headers: jar(cookie, parent),
    });
    expect(ack.statusCode, ack.body).toBe(200);
    const after = await say(id, 'why is the sky blue');
    expect(after.body.crisisLock).toBe(false);
    expect(router.calls.sandbox).toBe(1);
  });

  it('a CHILD cannot lift their own crisis lock', async () => {
    // The whole mechanism turns on this. Before the parent cookie existed the
    // route needed nothing at all, and a child who found the URL was a parent.
    const id = await openSession();
    await say(id, 'i want to die');
    const ack = await app.inject({ method: 'POST', url: `/v1/session/${id}/crisis/ack` });
    expect(ack.statusCode).toBe(403);
    expect(ack.json<{ code: string }>().code).toBe('PARENT_REQUIRED');

    const after = await say(id, 'why is the sky blue');
    expect(after.body.crisisLock, 'still locked').toBe(true);
  });

  it('one family\'s parent cannot unlock another family\'s child', async () => {
    const mine = await openSessionAsParent();
    const theirs = await openSessionAsParent();
    await say(theirs.sessionId, 'i want to die');

    const ack = await app.inject({
      method: 'POST', url: `/v1/session/${theirs.sessionId}/crisis/ack`,
      headers: jar(theirs.cookie, mine.parent),        // valid cookie, wrong family
    });
    expect(ack.statusCode).toBe(403);
  });

  it('helplines follow the session’s country', async () => {
    const id = await openSession({ country: 'US', method: 'dev_stub' });
    const { body } = await say(id, 'i want to die');
    expect(shown(body)).toMatch(/988/);
  });
});

describe('the response carries no raw model text', () => {
  it('never returns an unrendered block tag', async () => {
    router.reply = 'Look! [BIG]🦕[/BIG] [FACT]Birds are dinosaurs[/FACT] [CHIPS]More|Quiz[/CHIPS]';
    const id = await openSession();
    const { body } = await say(id, 'tell me about dinosaurs');
    const raw = JSON.stringify(body.blocks);
    for (const tag of ['[BIG]', '[FACT]', '[CHIPS]', '[/CHIPS]']) {
      expect(raw, `${tag} leaked`).not.toContain(tag);
    }
    expect(body.blocks.map((b) => b.kind))
      .toEqual(expect.arrayContaining(['text', 'big', 'fact', 'chips']));
  });

  it('markup from a model becomes inert text, never a rendered node', async () => {
    router.reply = 'Careful <img src=x onerror=alert(1)> ok [CHIPS]Next[/CHIPS]';
    const id = await openSession();
    const { body } = await say(id, 'hello');
    // it survives as TEXT inside a text block — the client renders from the AST
    const textBlock = body.blocks.find((b) => b.kind === 'text');
    expect(textBlock?.kind === 'text' && textBlock.text).toContain('<img');
    // there is no block kind through which markup could be rendered as markup
    expect(body.blocks.every((b) => b.kind !== ('html' as never))).toBe(true);
  });

  it('a raw escalation token never reaches the child', async () => {
    router.reply = 'CRISIS';
    const id = await openSession();
    const { body } = await say(id, 'tell me something');
    expect(shown(body).trim()).not.toBe('CRISIS');
    expect(shown(body)).toMatch(/helpline|1098|trusted adult/i);
  });

  it('an L6 failure is replaced and flagged', async () => {
    router.reply = 'i will miss you so much';
    const id = await openSession();
    const { body } = await say(id, 'i have to go');
    expect(shown(body)).not.toContain('miss you');
    expect(body.flags.map((f) => f.category)).toContain('OUTPUT-FILTER');
  });
});

describe('honest degradation', () => {
  it('a provider outage still answers the child, marked in the trace', async () => {
    const id = await openSession();
    router.classify = async () => { throw new Error('down'); };
    router.generate = async () => { throw new Error('down'); };
    const { status, body } = await say(id, 'why is the sky blue');
    expect(status).toBe(200);
    expect(body.trace).toMatch(/FAST-PATH-ONLY|unavailable/);
    expect(shown(body).length).toBeGreaterThan(0);
  });

  it('a 500 never returns internal detail', async () => {
    const id = await openSession();
    router.generate = async () => { throw new Error('sk-ant-SECRET-KEY leaked in message'); };
    const { body } = await say(id, 'why is the sky blue');
    expect(JSON.stringify(body)).not.toContain('sk-ant');
  });
});

describe('the seal chain is per session and verifies', () => {
  it('verifies after several turns', async () => {
    const id = await openSession();
    for (const t of ['why do volcanoes erupt', 'what is 9 + 6', 'tell me more']) {
      await say(id, t);
    }
    const res = await app.inject({ method: 'GET', url: `/v1/session/${id}/seal` });
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json<{ records: number }>().records).toBeGreaterThan(3);
  });

  it('two sessions do not share a chain', async () => {
    const a = await openSession();
    const b = await openSession();
    await say(a, 'why is the sky blue');
    const ra = await app.inject({ method: 'GET', url: `/v1/session/${a}/seal` });
    const rb = await app.inject({ method: 'GET', url: `/v1/session/${b}/seal` });
    expect(ra.json<{ records: number }>().records)
      .toBeGreaterThan(rb.json<{ records: number }>().records);
  });
});

// ---------------------------------------------------------------------------

describe('Law 02 — consent before existence', () => {
  it('refuses a session with NO cookie at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/session', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('no-consent');
  });

  it('refuses a session with a made-up cookie', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/session',
      headers: jar('a'.repeat(43)), payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('no-consent');
  });

  it('refuses a token presented in the BODY — there is no fallback path', async () => {
    // Two ways in would make the safe one optional. The body field is not in
    // the schema, so presenting it is a 400 rather than a quiet success.
    const { cookie } = await grantConsent();
    const res = await app.inject({
      method: 'POST', url: '/v1/session', payload: { consentToken: cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('issues NO token until the consent is finalized', async () => {
    const d = await app.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: {
        parentName: 'L', parentEmail: `s${++seq}@example.com`,
        childFirstName: 'M', country: 'IN', band: 'builder',
        method: 'dev_stub', pin: '4917', pinConfirm: '4917',
      },
    });
    expect(d.statusCode).toBe(201);
    expect(d.json<Record<string, unknown>>()).not.toHaveProperty('consentToken');
    expect(d.json<{ status: string }>().status).toBe('verifying');
  });

  it('a failed verification produces no consent and no token', async () => {
    const d = await app.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: {
        parentName: 'L', parentEmail: `s${++seq}@example.com`,
        childFirstName: 'M', country: 'IN', band: 'builder',
        method: 'signed_form_review', pin: '4917', pinConfirm: '4917',
      },
    });
    const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
    // no named reviewer -> the adapter refuses
    const f = await app.inject({
      method: 'POST', url: `/v1/consent/${consentId}/finalize`,
      payload: { challengeId, proof: {} },
    });
    expect(f.statusCode).toBe(422);
    expect(f.json<Record<string, unknown>>()).not.toHaveProperty('consentToken');
    expect(f.cookies.find((c) => c.name === CONSENT_COOKIE),
      'a failed verification must not set a cookie either').toBeUndefined();
  });

  it('the BAND comes from the sealed consent, not from the request', async () => {
    // a client cannot ask for a different band than it was granted: there is no
    // field on the session route through which to try
    const { cookie } = await grantConsent({ band: 'explorer' });
    const res = await app.inject({
      method: 'POST', url: '/v1/session',
      headers: jar(cookie), payload: { band: 'thinker' },
    });
    expect(res.statusCode, 'band is not an accepted field').toBe(400);

    const ok = await app.inject({
      method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
    });
    expect(ok.json<{ band: string }>().band).toBe('explorer');
  });

  it('memory is a SCOPE, not something the client turns on', async () => {
    const { cookie } = await grantConsent({ memoryOn: false });
    const res = await app.inject({
      method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
    });
    expect(res.statusCode).toBe(201);
    // proven by behaviour: a memory the classifier offers is not saved
    const sid = res.json<{ sessionId: string }>().sessionId;
    router.verdict = { label: 'SAFE', memory: { category: 'PET', fact: 'has a cat' }, assist: null };
    const turn = await say(sid, 'i have a cat');
    expect(turn.body.memorySaved).toBeUndefined();
  });
});

describe('revocation propagates', () => {
  it('ends live sessions and refuses new ones', async () => {
    const { cookie, parent, sessionId: sid } = await openSessionAsParent();
    expect((await say(sid, 'why is the sky blue')).status).toBe(200);

    const rev = await app.inject({
      method: 'DELETE', url: '/v1/consent', headers: jar(cookie, parent),
    });
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json<{ sessionsEnded: number }>().sessionsEnded).toBe(1);

    // 409, not 404: the session existed and was ended by the revocation. Saying
    // "not found" would be a small lie about something a parent just did.
    expect((await say(sid, 'still there?')).status).toBe(409);
    // and the cookie no longer opens a new one
    const again = await app.inject({
      method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
    });
    expect(again.statusCode).toBe(403);
  });

  it('CANNOT be triggered without a parent session', async () => {
    // This is the hole the parent cookie closes. The route used to take a
    // consent id in the path and check NOTHING, and the client was keeping an
    // id in localStorage where the child could read it.
    const { cookie } = await grantConsent();
    const rev = await app.inject({
      method: 'DELETE', url: '/v1/consent', headers: jar(cookie),
    });
    expect(rev.statusCode).toBe(403);
    expect(rev.json<{ code: string }>().code).toBe('PARENT_REQUIRED');

    // and nothing was erased
    const still = await app.inject({
      method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
    });
    expect(still.statusCode).toBe(201);
  });

  it('CANNOT be triggered with a forged parent cookie', async () => {
    const { cookie } = await grantConsent();
    const rev = await app.inject({
      method: 'DELETE', url: '/v1/consent',
      headers: jar(cookie, `${'c'.repeat(36)}|${Date.now() + 60_000}|deadbeef`),
    });
    expect(rev.statusCode).toBe(403);
  });

  it('one family cannot erase another family', async () => {
    const mine = await openSessionAsParent();
    const theirs = await grantConsent();
    const rev = await app.inject({
      method: 'DELETE', url: '/v1/consent',
      headers: jar(theirs.cookie, mine.parent),      // valid signature, wrong consent
    });
    expect(rev.statusCode).toBe(403);
  });

  it('returns the sealed ledger as proof the consent existed and was withdrawn', async () => {
    const { cookie, parent } = await openSessionAsParent();
    const rev = await app.inject({
      method: 'DELETE', url: '/v1/consent', headers: jar(cookie, parent),
    });
    const ledger = rev.json<{ ledger: { status: string; revokedAt: string; sealHash: string } }>().ledger;
    expect(ledger.status).toBe('revoked');
    expect(ledger.revokedAt).toBeTruthy();
    expect(ledger.sealHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clears both cookies, so the browser stops presenting dead credentials', async () => {
    const { cookie, parent } = await openSessionAsParent();
    const rev = await app.inject({
      method: 'DELETE', url: '/v1/consent', headers: jar(cookie, parent),
    });
    const names = rev.cookies.map((c) => c.name);
    expect(names).toContain(CONSENT_COOKIE);
    expect(names).toContain(PARENT_COOKIE);
    for (const c of rev.cookies) expect(c.value).toBe('');
  });
});

describe('consent methods offered', () => {
  it('never offers DigiLocker, and refuses it if asked', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/consent/methods?country=IN' });
    expect(list.json<{ methods: string[] }>().methods).not.toContain('digilocker');

    const d = await app.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: {
        parentName: 'L', parentEmail: `s${++seq}@example.com`,
        childFirstName: 'M', country: 'IN', band: 'builder',
        method: 'digilocker', pin: '4917', pinConfirm: '4917',
      },
    });
    expect(d.statusCode).toBe(400);
    expect(d.json<{ error: string }>().error).toMatch(/deferred/i);
  });

  it('refuses the dev stub when the deployment says production', async () => {
    const prod = await buildServer({ pool, keys, router: countingRouter(), env: 'prod', rateLimitMax: 100_000 });
    await prod.ready();
    const d = await prod.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: {
        parentName: 'L', parentEmail: `s${++seq}@example.com`,
        childFirstName: 'M', country: 'IN', band: 'builder',
        method: 'dev_stub', pin: '4917', pinConfirm: '4917',
      },
    });
    expect(d.statusCode).toBe(400);
    expect(d.json<{ error: string }>().error).toMatch(/not permitted in production/i);
    await prod.close();
  });
});

describe('parent PIN over HTTP', () => {
  it('rejects a weak PIN at draft time', async () => {
    for (const pin of ['1234', '0000', '4321', '9999']) {
      const res = await app.inject({
        method: 'POST', url: '/v1/consent/draft',
        payload: {
          parentName: 'L', parentEmail: `s${++seq}@example.com`,
        childFirstName: 'M', country: 'IN', band: 'builder',
          method: 'dev_stub', pin, pinConfirm: pin,
        },
      });
      expect(res.statusCode, pin).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/easy to guess/i);
    }
  });

  it('verifies the right PIN and refuses the wrong one', async () => {
    const { cookie } = await grantConsent();
    const good = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(cookie), payload: { pin: '4917' },
    });
    expect(good.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(cookie), payload: { pin: '4918' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('mints a parent session ONLY on a correct PIN', async () => {
    const { cookie } = await grantConsent();
    const bad = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(cookie), payload: { pin: '4918' },
    });
    expect(bad.cookies.find((c) => c.name === PARENT_COOKIE)).toBeUndefined();

    const good = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(cookie), payload: { pin: '4917' },
    });
    const minted = good.cookies.find((c) => c.name === PARENT_COOKIE);
    expect(minted).toBeDefined();
    expect(minted!.httpOnly, 'the parent session must not be readable by script').toBe(true);
    expect(minted!.sameSite?.toLowerCase()).toBe('strict');
  });

  it('refuses a PIN with no consent cookie, in the same shape as a wrong PIN', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify', payload: { pin: '4917' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, locked: false });
  });

  it('locks out after five wrong attempts, and says so once', async () => {
    const { cookie } = await grantConsent();
    const tries = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/parent/pin/verify',
        headers: jar(cookie), payload: { pin: '4918' },
      });
      tries.push(r.json<{ locked: boolean; note?: string }>());
    }
    expect(tries.slice(0, 4).every((t) => !t.locked)).toBe(true);
    expect(tries[4]!.locked).toBe(true);
    expect(tries[4]!.note).toMatch(/curious child/i);
    expect(tries[5]!.note, 'flagged once, not on every later try').toBeUndefined();
  });

  it('a correct PIN during lockout still fails, and mints nothing', async () => {
    const { cookie } = await grantConsent();
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST', url: '/v1/parent/pin/verify',
        headers: jar(cookie), payload: { pin: '4918' },
      });
    }
    const r = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(cookie), payload: { pin: '4917' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json<{ locked: boolean }>().locked).toBe(true);
    expect(r.cookies.find((c) => c.name === PARENT_COOKIE)).toBeUndefined();
  });

  it('does not reveal whether a cookie belongs to a real consent', async () => {
    const real = await grantConsent();
    const a = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar(real.cookie), payload: { pin: '4918' },
    });
    const b = await app.inject({
      method: 'POST', url: '/v1/parent/pin/verify',
      headers: jar('b'.repeat(43)), payload: { pin: '4918' },
    });
    expect(a.statusCode).toBe(b.statusCode);
  });
});

describe('rate limiting', () => {
  it('refuses a flood of turns on one session', async () => {
    const limited = await buildServer({ pool, keys, router: countingRouter(), rateLimitMax: 5 });
    await limited.ready();
    const d = await limited.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: {
        parentName: 'L', parentEmail: `rl${++seq}@example.com`, childFirstName: 'M',
        country: 'IN', band: 'builder', method: 'dev_stub',
        pin: '4917', pinConfirm: '4917',
      },
    });
    const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
    const fin = await limited.inject({
      method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId },
    });
    const ses = await limited.inject({
      method: 'POST', url: '/v1/session',
      payload: { consentToken: fin.json<{ consentToken: string }>().consentToken },
    });
    const sid = ses.json<{ sessionId: string }>().sessionId;

    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await limited.inject({
        method: 'POST', url: `/v1/session/${sid}/turn`, payload: { text: 'hello there' },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toContain(429);
    await limited.close();
  });
});

describe('the memory book', () => {
  /** Make the classifier volunteer a memory, so a real row exists to read back. */
  async function withOneMemory() {
    const id = await openSession();
    router.verdict = {
      label: 'SAFE',
      memory: { category: 'PET', fact: 'has a cat named Mani' },
      assist: null,
    };
    await say(id, 'my cat is called Mani');
    return id;
  }

  it('lists what was remembered', async () => {
    const id = await withOneMemory();
    const res = await app.inject({ method: 'GET', url: `/v1/session/${id}/memories` });
    expect(res.statusCode, res.body).toBe(200);
    const { memories } = res.json<{ memories: { category: string; fact: string }[] }>();
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ category: 'PET', fact: 'has a cat named Mani' });
  });

  it('lets a CHILD delete, not only a parent', async () => {
    // Requirements §4.3 — the child's copy of the memory book is not a
    // decoration; the whole point of showing it is that they can act on it.
    const id = await withOneMemory();
    const list = await app.inject({ method: 'GET', url: `/v1/session/${id}/memories` });
    const memId = list.json<{ memories: { id: string }[] }>().memories[0]!.id;

    const del = await app.inject({
      method: 'DELETE', url: `/v1/session/${id}/memories/${memId}?by=child`,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json<{ forgotten: boolean }>().forgotten).toBe(true);

    const after = await app.inject({ method: 'GET', url: `/v1/session/${id}/memories` });
    expect(after.json<{ memories: unknown[] }>().memories).toHaveLength(0);
  });

  it('seals the deletion, so "you can delete it" is checkable', async () => {
    const id = await withOneMemory();
    const before = await app.inject({ method: 'GET', url: `/v1/session/${id}/seal` });
    const n = before.json<{ records: number }>().records;

    const list = await app.inject({ method: 'GET', url: `/v1/session/${id}/memories` });
    const memId = list.json<{ memories: { id: string }[] }>().memories[0]!.id;
    await app.inject({ method: 'DELETE', url: `/v1/session/${id}/memories/${memId}` });

    const after = await app.inject({ method: 'GET', url: `/v1/session/${id}/seal` });
    expect(after.json<{ records: number }>().records).toBe(n + 1);
    // The FACT of the deletion is sealed. The fact deleted is not.
    expect(after.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('is idempotent — deleting twice reports not-found, never a false success', async () => {
    const id = await withOneMemory();
    const list = await app.inject({ method: 'GET', url: `/v1/session/${id}/memories` });
    const memId = list.json<{ memories: { id: string }[] }>().memories[0]!.id;

    await app.inject({ method: 'DELETE', url: `/v1/session/${id}/memories/${memId}` });
    const second = await app.inject({
      method: 'DELETE', url: `/v1/session/${id}/memories/${memId}`,
    });
    expect(second.statusCode).toBe(404);
    expect(second.json<{ forgotten: boolean }>().forgotten).toBe(false);
  });

  it('one family cannot delete another family\'s memory', async () => {
    // The session id is the capability. Naming someone else's memory id from
    // your own session must not work, because row-level security is scoped to
    // the child the SESSION belongs to, never to anything in the request.
    const theirs = await withOneMemory();
    const list = await app.inject({ method: 'GET', url: `/v1/session/${theirs}/memories` });
    const theirMemId = list.json<{ memories: { id: string }[] }>().memories[0]!.id;

    const mine = await openSession();
    const attack = await app.inject({
      method: 'DELETE', url: `/v1/session/${mine}/memories/${theirMemId}`,
    });
    expect(attack.statusCode).toBe(404);

    const still = await app.inject({ method: 'GET', url: `/v1/session/${theirs}/memories` });
    expect(still.json<{ memories: unknown[] }>().memories).toHaveLength(1);
  });

  it('one family cannot READ another family\'s memories', async () => {
    const theirs = await withOneMemory();
    const mine = await openSession();
    const res = await app.inject({ method: 'GET', url: `/v1/session/${mine}/memories` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ memories: unknown[] }>().memories).toHaveLength(0);
    expect(theirs).not.toBe(mine);
  });

  it('404s for a session that does not exist', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/session/99999999-9999-4999-8999-999999999999/memories',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a `by` value that is neither child nor parent', async () => {
    const id = await withOneMemory();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/session/${id}/memories/11111111-1111-4111-8111-111111111111?by=admin`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the consent token never leaves the cookie', () => {
  it('finalize returns a ledger and no credential', async () => {
    const d = await app.inject({
      method: 'POST', url: '/v1/consent/draft',
      payload: {
        parentName: 'L', parentEmail: `c${++seq}@example.com`,
        childFirstName: 'M', country: 'IN', band: 'builder',
        method: 'dev_stub', pin: '4917', pinConfirm: '4917',
      },
    });
    const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
    const f = await app.inject({
      method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId },
    });

    expect(f.statusCode, f.body).toBe(200);
    const token = f.cookies.find((c) => c.name === CONSENT_COOKIE)!.value;
    expect(token.length).toBeGreaterThan(20);
    // The body must not contain it anywhere — not as a field, not nested in the
    // ledger. A response body is readable by every script on the page.
    expect(f.body).not.toContain(token);
    expect(f.json<Record<string, unknown>>()).not.toHaveProperty('consentToken');
  });

  it('sets httpOnly and SameSite=Strict', async () => {
    const { consentId, challengeId } = await (async () => {
      const d = await app.inject({
        method: 'POST', url: '/v1/consent/draft',
        payload: {
          parentName: 'L', parentEmail: `c${++seq}@example.com`,
          childFirstName: 'M', country: 'IN', band: 'builder',
          method: 'dev_stub', pin: '4917', pinConfirm: '4917',
        },
      });
      return d.json<{ consentId: string; challengeId: string }>();
    })();
    const f = await app.inject({
      method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId },
    });
    const c = f.cookies.find((x) => x.name === CONSENT_COOKIE)!;
    expect(c.httpOnly, 'a script must never be able to read it').toBe(true);
    expect(c.sameSite?.toLowerCase()).toBe('strict');
    expect(c.path).toBe('/');
  });

  it('sets Secure outside development', async () => {
    // Omitted in dev only, so the cookie works over plain-HTTP localhost. Any
    // deployed environment must not send a child's credential in the clear.
    const prod = await buildServer({
      pool, keys, router: countingRouter(), env: 'staging', rateLimitMax: 100_000,
    });
    await prod.ready();
    try {
      const d = await prod.inject({
        method: 'POST', url: '/v1/consent/draft',
        payload: {
          parentName: 'L', parentEmail: `c${++seq}@example.com`,
          childFirstName: 'M', country: 'IN', band: 'builder',
          method: 'signed_form_review', pin: '4917', pinConfirm: '4917',
        },
      });
      // dev_stub is refused outside dev, so this uses a real adapter and a
      // named reviewer to reach an actual activation.
      const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
      const f = await prod.inject({
        method: 'POST', url: `/v1/consent/${consentId}/finalize`,
        payload: { challengeId, proof: { reviewerId: 'ops@tulifo.ai', documentDigest: 'sha256:abc' } },
      });
      const c = f.cookies.find((x) => x.name === CONSENT_COOKIE);
      expect(c, f.body).toBeDefined();
      expect(c!.secure).toBe(true);
    } finally {
      await prod.close();
    }
  });
});

describe('GET /v1/consent/status', () => {
  it('says no for a browser with no cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consent/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('returns the band from the sealed record, and no credential', async () => {
    const { cookie } = await grantConsent({ band: 'explorer' });
    const res = await app.inject({
      method: 'GET', url: '/v1/consent/status', headers: jar(cookie),
    });
    const body = res.json<{ active: boolean; band: string; childFirstName: string }>();
    expect(body.active).toBe(true);
    expect(body.band).toBe('explorer');
    expect(body.childFirstName).toBe('Meera');
    // Nothing here may be used to authenticate anything.
    expect(res.body).not.toContain(cookie);
    expect(body).not.toHaveProperty('consentId');
  });

  it('says no AND clears the cookie once the consent is revoked', async () => {
    const { cookie, parent } = await openSessionAsParent();
    await app.inject({ method: 'DELETE', url: '/v1/consent', headers: jar(cookie, parent) });

    const res = await app.inject({
      method: 'GET', url: '/v1/consent/status', headers: jar(cookie),
    });
    expect(res.json<{ active: boolean }>().active).toBe(false);
    const cleared = res.cookies.find((c) => c.name === CONSENT_COOKIE);
    expect(cleared?.value, 'stop presenting a credential that means nothing').toBe('');
  });
});

describe('the parent dashboard', () => {
  it('refuses without a parent session, in the same shape for everyone', async () => {
    const { cookie } = await grantConsent();
    // Signed in as the CHILD — which is what the browser normally is.
    const asChild = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(cookie),
    });
    expect(asChild.statusCode).toBe(403);
    expect(asChild.json<{ code: string }>().code).toBe('PARENT_REQUIRED');

    const asNobody = await app.inject({ method: 'GET', url: '/v1/parent/dashboard' });
    expect(asNobody.statusCode).toBe(403);
  });

  it('reports stats a parent can act on', async () => {
    const { cookie, parent, sessionId } = await openSessionAsParent();
    router.verdict = {
      label: 'SAFE', memory: { category: 'PET', fact: 'has a cat named Mani' }, assist: null,
    };
    await say(sessionId, 'my cat is called Mani');
    await say(sessionId, 'why is the sky blue');

    const res = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(cookie, parent),
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<{
      child: { firstName: string; band: string };
      stats: { sessions: number; messages: number; memories: number };
      sessions: { id: string; msgCount: number }[];
      memories: { fact: string }[];
    }>();

    expect(d.child.firstName).toBe('Meera');
    expect(d.child.band).toBe('builder');
    expect(d.stats.sessions).toBe(1);
    expect(d.stats.messages).toBe(2);
    expect(d.stats.memories).toBe(1);
    expect(d.sessions[0]!.id).toBe(sessionId);
    expect(d.memories[0]!.fact).toBe('has a cat named Mani');
  });

  it('carries local helplines, so a crisis panel is never a dead end', async () => {
    const { cookie, parent } = await openSessionAsParent({ country: 'IN' });
    const res = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(cookie, parent),
    });
    const h = res.json<{ helplines: { lines: { name: string; contact: string }[] } }>();
    expect(h.helplines.lines.length).toBeGreaterThan(0);
    for (const l of h.helplines.lines) expect(l.contact).toBeTruthy();
  });

  it('one family sees nothing of another', async () => {
    const theirs = await openSessionAsParent();
    router.verdict = {
      label: 'SAFE', memory: { category: 'PET', fact: 'has a dog named Rex' }, assist: null,
    };
    await say(theirs.sessionId, 'my dog is rex');

    const mine = await openSessionAsParent();
    const res = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(mine.cookie, mine.parent),
    });
    const d = res.json<{ memories: unknown[]; sessions: { id: string }[] }>();
    expect(d.memories).toHaveLength(0);
    expect(d.sessions.map((s) => s.id)).not.toContain(theirs.sessionId);
    expect(res.body).not.toContain('Rex');
  });

  it('never carries a child\'s words in a flag', async () => {
    // The doctrine that is easiest to break by accident: a flag names a
    // CATEGORY and vetted template wording, never what was typed.
    const { cookie, parent, sessionId } = await openSessionAsParent();
    await say(sessionId, 'my neighbour touches me and says it is our little secret');

    const res = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(cookie, parent),
    });
    const d = res.json<{ flags: { safety: { category: string; body: string }[] } }>();
    expect(d.flags.safety.length).toBeGreaterThan(0);

    // Nothing distinctive from the child's sentence may appear anywhere in the
    // response — not in a flag, not in a session summary, not in the stats.
    for (const word of ['neighbour', 'touches', 'little secret']) {
      expect(res.body.toLowerCase()).not.toContain(word);
    }
  });

  it('says plainly that no per-child learning queue exists', async () => {
    // `learning_insight` has no FK to child by design, so there is nothing of
    // this child's to show. An empty panel would be read as "nothing yet".
    const { cookie, parent } = await openSessionAsParent({ learnOn: true });
    const res = await app.inject({
      method: 'GET', url: '/v1/parent/dashboard', headers: jar(cookie, parent),
    });
    const l = res.json<{ learning: { optedIn: boolean; perChildQueueExists: boolean } }>().learning;
    expect(l.optedIn).toBe(true);
    expect(l.perChildQueueExists).toBe(false);
  });
});

describe('the teen carve-out', () => {
  it('gives a parent the full transcript for a BUILDER', async () => {
    const { cookie, parent, sessionId } = await openSessionAsParent({ band: 'builder' });
    await say(sessionId, 'why is the sky blue');

    const res = await app.inject({
      method: 'GET', url: `/v1/parent/sessions/${sessionId}/transcript`,
      headers: jar(cookie, parent),
    });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json<{ bodiesIncluded: boolean; turns: { role: string; body: string | null }[] }>();
    expect(t.bodiesIncluded).toBe(true);
    expect(t.turns.find((x) => x.role === 'child')?.body).toBe('why is the sky blue');
  });

  it('gives a THINKER\'s parent topics only, and says so', async () => {
    const { cookie, parent, sessionId } = await openSessionAsParent({ band: 'thinker' });
    await say(sessionId, 'why is the sky blue');

    const res = await app.inject({
      method: 'GET', url: `/v1/parent/sessions/${sessionId}/transcript`,
      headers: jar(cookie, parent),
    });
    const t = res.json<{
      band: string; bodiesIncluded: boolean; note: string | null;
      turns: { role: string; body: string | null; topic: string | null }[];
    }>();

    expect(t.band).toBe('thinker');
    expect(t.bodiesIncluded).toBe(false);
    expect(t.note).toMatch(/topics-only/i);
    expect(t.turns.length).toBeGreaterThan(0);
    for (const turn of t.turns) expect(turn.body).toBeNull();
    // And the words are not hiding anywhere else in the payload.
    expect(res.body).not.toContain('why is the sky blue');
  });

  /**
   * The API-level carve-out, proven independently of the database.
   *
   * `teen_bodies_are_never_stored` is a CHECK on `message.band`, while the
   * route decides from `session.band`. Those can disagree — a band change
   * mid-session, or a bug writing the wrong band — and in that gap the database
   * has nothing to say. This builds exactly that row and asserts the API still
   * withholds it.
   *
   * Without this test, deleting the `teen ? null :` in the route changed
   * nothing observable, which is a good definition of an untested guard.
   */
  it('withholds a teen\'s body even when one exists in the table', async () => {
    const { cookie, parent, sessionId } = await openSessionAsParent({ band: 'thinker' });

    const store = createStore(pool, keys);
    const childId = (await pool.query<{ child_id: string }>(
      `SELECT child_id FROM session WHERE id = $1`, [sessionId])).rows[0]!.child_id;

    // band='builder' on a message inside a thinker's session: the CHECK permits
    // it, so a real encrypted body lands in the table.
    await store.withChild(childId, (tx) => store.child.addMessage(
      tx, sessionId, childId, 'builder', 'child',
      'a sentence a teenager typed', null, 'chat', {}));

    const raw = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM message
        WHERE session_id = $1 AND body_enc IS NOT NULL`, [sessionId]);
    expect(raw.rows[0]!.n, 'the fixture must actually store a body').toBe(1);

    const res = await app.inject({
      method: 'GET', url: `/v1/parent/sessions/${sessionId}/transcript`,
      headers: jar(cookie, parent),
    });
    const t = res.json<{ bodiesIncluded: boolean; turns: { body: string | null }[] }>();
    expect(t.bodiesIncluded).toBe(false);
    for (const turn of t.turns) expect(turn.body).toBeNull();
    expect(res.body).not.toContain('a sentence a teenager typed');
  });

  it('refuses a transcript without a parent session', async () => {
    const { cookie, sessionId } = await openSessionAsParent();
    const res = await app.inject({
      method: 'GET', url: `/v1/parent/sessions/${sessionId}/transcript`,
      headers: jar(cookie),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s another family\'s session rather than revealing it exists', async () => {
    const theirs = await openSessionAsParent();
    const mine = await openSessionAsParent();
    const real = await app.inject({
      method: 'GET', url: `/v1/parent/sessions/${theirs.sessionId}/transcript`,
      headers: jar(mine.cookie, mine.parent),
    });
    const fake = await app.inject({
      method: 'GET', url: '/v1/parent/sessions/99999999-9999-4999-8999-999999999999/transcript',
      headers: jar(mine.cookie, mine.parent),
    });
    expect(real.statusCode).toBe(404);
    expect(real.body).toBe(fake.body);
  });
});

describe('GET /v1/helplines/:country', () => {
  it('is reachable WITHOUT any cookie', async () => {
    // A child in trouble must not need an adult to unlock a helpline first.
    const res = await app.inject({ method: 'GET', url: '/v1/helplines/IN' });
    expect(res.statusCode).toBe(200);
    const r = res.json<{ country: string; lines: { name: string; contact: string }[] }>();
    expect(r.country).toBe('IN');
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it('accepts lower case', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/helplines/in' })).statusCode).toBe(200);
  });

  it('404s a country with no verified lines rather than inventing one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/helplines/ZZ' });
    expect(res.statusCode).toBe(404);
  });
});
