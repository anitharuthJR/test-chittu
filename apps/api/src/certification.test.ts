/**
 * The two D5 dashboard nodes the port left behind: the maths harness and the
 * certification readiness checklist.
 *
 * Both are parent-gated, and both make a claim that is only worth anything if
 * it is measured rather than asserted:
 *
 *   1. The harness audits the DETERMINISTIC engine, so it must reach no model.
 *      The prototype's version graded a model against ground truth; ours grades
 *      the engine that answers arithmetic in the product, which is the whole
 *      claim the layer exists to demonstrate. `router.calls` is the instrument.
 *   2. The checklist must report what is TRUE of this system, not a list of
 *      ticks somebody maintains by hand. A checklist that claims a control is
 *      in place when it is not is worse than no checklist — so the tests below
 *      pin the two rows most likely to drift into a lie: the database role
 *      separation (declarative, inert, and it must say so) and the rows that
 *      are simply not done.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ClassifierOutcome } from '@chittu/contracts';
import { randomBytes } from 'node:crypto';
import { createTestDb, localKeyProvider, helplineRepo, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import { CONSENT_COOKIE, PARENT_COOKIE } from './cookies.js';
import type { ProviderRouter } from './providers.js';
import { HARNESS_ITEMS, runMathsHarness } from './maths-harness.js';
import type { CertificationResponse, ControlStatus } from './certification.js';
import type { HarnessResponse } from './maths-harness.js';

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

async function grantConsent(over: Record<string, unknown> = {}) {
  const d = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: {
      parentName: 'Lakshmi', parentEmail: `cert${++seq}@example.com`,
      childFirstName: 'Meera', country: 'IN',
      band: 'builder', board: 'CBSE', method: 'dev_stub',
      pin: '4917', pinConfirm: '4917', ...over,
    },
  });
  expect(d.statusCode, d.body).toBe(201);
  const { consentId, challengeId } = d.json<{ consentId: string; challengeId: string }>();
  const f = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId },
  });
  expect(f.statusCode, f.body).toBe(200);
  return { consentId, cookie: f.cookies.find((c) => c.name === CONSENT_COOKIE)!.value };
}

function jar(consent?: string, parent?: string): Record<string, string> {
  const parts: string[] = [];
  if (consent !== undefined) parts.push(`${CONSENT_COOKIE}=${consent}`);
  if (parent !== undefined) parts.push(`${PARENT_COOKIE}=${parent}`);
  return parts.length > 0 ? { cookie: parts.join('; ') } : {};
}

/** Consent + a live parent session, plus a started chat to seal against. */
async function asParent(over: Record<string, unknown> = {}) {
  const { cookie } = await grantConsent(over);
  const s = await app.inject({
    method: 'POST', url: '/v1/session', headers: jar(cookie), payload: {},
  });
  expect(s.statusCode, s.body).toBe(201);
  const v = await app.inject({
    method: 'POST', url: '/v1/parent/pin/verify', headers: jar(cookie), payload: { pin: '4917' },
  });
  expect(v.statusCode, v.body).toBe(200);
  return {
    cookie, parent: v.cookies.find((c) => c.name === PARENT_COOKIE)!.value,
    sessionId: s.json<{ sessionId: string }>().sessionId,
  };
}

const row = (r: CertificationResponse, id: string) => {
  const found = r.controls.find((c) => c.id === id);
  expect(found, `no control row "${id}"`).toBeDefined();
  return found!;
};

// ---------------------------------------------------------------------------

describe('the parent gate on both new routes', () => {
  const urls = ['/v1/parent/maths-check', '/v1/parent/certification'];

  it.each(urls)('%s refuses a request with no cookies at all', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('PARENT_REQUIRED');
  });

  it.each(urls)('%s refuses a CONSENT cookie alone — that is a child', async (url) => {
    const { cookie } = await grantConsent();
    const res = await app.inject({ method: 'GET', url, headers: jar(cookie) });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('PARENT_REQUIRED');
  });

  it.each(urls)('%s answers a PIN-minted parent session', async (url) => {
    const { cookie, parent } = await asParent();
    const res = await app.inject({ method: 'GET', url, headers: jar(cookie, parent) });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('maths harness', () => {
  it('runs five live checks against known-correct answers', async () => {
    const { cookie, parent } = await asParent();
    const res = await app.inject({
      method: 'GET', url: '/v1/parent/maths-check', headers: jar(cookie, parent),
    });
    const b = res.json<HarnessResponse>();
    expect(b.items).toHaveLength(5);
    expect(b.total).toBe(5);
    expect(b.passed).toBe(5);
    expect(b.ok).toBe(true);
    for (const i of b.items) {
      expect(i.got, i.shown).toBe(i.truth);
      expect(i.inTheLesson, `${i.shown} must reach the child's lesson`).toBe(true);
    }
  });

  /**
   * The claim the harness exists to demonstrate. Counted, not asserted: the
   * router is injected, so a route that reached a vendor would move a number.
   */
  it('makes ZERO model calls — it audits the deterministic engine', async () => {
    const { cookie, parent } = await asParent();
    const before = { ...router.calls };
    await app.inject({
      method: 'GET', url: '/v1/parent/maths-check', headers: jar(cookie, parent),
    });
    expect(router.calls).toEqual(before);
    expect(router.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  /**
   * A harness that always says 5/5 is exactly the instrument this repo keeps
   * finding — three have now been caught measuring themselves. This one must be
   * able to report a failure, so it is handed a wrong truth and must say so.
   */
  it('can fail — a wrong expected answer is reported, not smoothed over', () => {
    const r = runMathsHarness(
      { band: 'builder', board: 'CBSE', kid: 'Meera' },
      [{ ask: 'what is 7 x 8', shown: '7 × 8', truth: 57 }],
    );
    expect(r.ok).toBe(false);
    expect(r.passed).toBe(0);
    expect(r.items[0]!.got).toBe(56);
  });

  it('reports a sum the engine cannot parse as unanswered, never as a pass', () => {
    const r = runMathsHarness(
      { band: 'builder', board: 'CBSE', kid: 'Meera' },
      [{ ask: 'how many mangoes are in a basket', shown: 'not arithmetic', truth: 3 }],
    );
    expect(r.items[0]!.got).toBeNull();
    expect(r.items[0]!.ok).toBe(false);
  });

  /** The truth column is hand-written. Derived from `calc` it would be circular. */
  it('carries hand-computed answers, not answers the engine supplied', () => {
    expect(HARNESS_ITEMS.map((i) => i.truth)).toEqual([56, 8, 500, 753, 180]);
  });
});

describe('certification readiness', () => {
  it('names the database role separation as DECLARATIVE, and does not claim it', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();

    const r = row(b, 'database-role-separation');
    expect(r.status).toBe<ControlStatus>('declarative');
    // The evidence must say what was actually read, and it must not read as a pass.
    expect(r.evidence).toMatch(/NOLOGIN/i);
    expect(r.evidence).toMatch(/owner/i);
    expect(r.evidence).toMatch(/not (enforced|switched on)|inert/i);
    expect(r.status).not.toBe('enforced');
  });

  it('reads the roles and RLS from Postgres rather than from a list', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    // Both roles exist in this database and cannot log in; FORCE RLS is set
    // nowhere. If any of that changed, the row must change with it.
    const e = row(b, 'database-role-separation').evidence;
    expect(e).toMatch(/chittu_app \(NOLOGIN\)/);
    expect(e).toMatch(/chittu_ops \(NOLOGIN\)/);
    expect(e).toMatch(/FORCE ROW LEVEL SECURITY/i);
    /**
     * Positive control. The migration creates five policies and this service
     * owns five child tables, so a probe reporting zero of either is looking in
     * the wrong schema — and "nothing found" is indistinguishable from the very
     * answer this row is supposed to reach. It happened: the first version
     * pinned the probe to `public` while the fixture builds a throwaway schema.
     */
    expect(e, 'the probe must find the policies it is reporting on').toMatch(/5 row-level policies/);
    expect(e).toMatch(/owns 5 of 5 child tables/);
    // ...and having found them, must still report them as inert.
    expect(e).toMatch(/0 table\(s\) have FORCE ROW LEVEL SECURITY/);
  });

  it('marks the reviews nobody has done as not done', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    for (const id of ['independent-audit', 'clinical-review', 'red-team-gate']) {
      expect(row(b, id).status, id).toBe<ControlStatus>('absent');
    }
  });

  it('reads the teen carve-out from the constraint that enforces it', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    const r = row(b, 'teen-words-never-stored');
    expect(r.status).toBe<ControlStatus>('enforced');
    expect(r.evidence).toMatch(/teen_bodies_are_never_stored/);
  });

  it('degrades the helpline row when the registry is flagged WRONG', async () => {
    const { cookie, parent } = await asParent({ country: 'AU' });
    const good = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    expect(row(good, 'crisis-helplines').status).toBe<ControlStatus>('partial');

    await helplineRepo(pool).upsert(
      pool, 'AU', [{ name: 'Checked Line', number: '0800-1111' }],
      'ops@tulifo.ai', new Date(Date.now() + 30 * 86_400_000));
    const verified = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    expect(row(verified, 'crisis-helplines').status).toBe<ControlStatus>('enforced');

    await helplineRepo(pool).flagP0(pool, 'AU', 'ops@tulifo.ai');
    const wrong = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    expect(row(wrong, 'crisis-helplines').status).toBe<ControlStatus>('partial');
  });

  it('says the consent method for THIS family, and calls a stub a stub', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    const r = row(b, 'verifiable-consent');
    // `dev_stub` completes; nothing verifies a real adult. It must not read as done.
    expect(r.status).toBe<ControlStatus>('partial');
    expect(r.evidence).toMatch(/dev_stub/);
  });

  it('quotes nothing a child typed', async () => {
    const { cookie, parent, sessionId } = await asParent();
    const secret = 'my rabbit is called Pambaram and lives in a blue box';
    await app.inject({
      method: 'POST', url: `/v1/session/${sessionId}/turn`, payload: { text: secret },
    });
    const res = await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    });
    expect(res.body).not.toContain('Pambaram');
    expect(res.body).not.toContain('blue box');
  });

  it('makes ZERO model calls', async () => {
    const { cookie, parent } = await asParent();
    const before = { ...router.calls };
    await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    });
    expect(router.calls).toEqual(before);
  });

  it('counts its own rows, so the summary cannot disagree with the list', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    const tally = (s: ControlStatus) => b.controls.filter((c) => c.status === s).length;
    expect(b.summary.enforced).toBe(tally('enforced'));
    expect(b.summary.partial).toBe(tally('partial'));
    expect(b.summary.declarative).toBe(tally('declarative'));
    expect(b.summary.absent).toBe(tally('absent'));
    expect(b.controls.length).toBe(
      b.summary.enforced + b.summary.partial + b.summary.declarative + b.summary.absent);
  });

  it('gives every row words a parent can read, not our vocabulary', async () => {
    const { cookie, parent } = await asParent();
    const b = (await app.inject({
      method: 'GET', url: '/v1/parent/certification', headers: jar(cookie, parent),
    })).json<CertificationResponse>();
    expect(b.controls.length).toBeGreaterThan(0);
    for (const c of b.controls) {
      expect(c.title.length, c.id).toBeGreaterThan(0);
      expect(c.label.length, c.id).toBeGreaterThan(0);
      expect(c.detail.length, c.id).toBeGreaterThan(0);
      expect(c.evidence.length, c.id).toBeGreaterThan(0);
      // "spine" is ours. A parent should not have to learn it to read this.
      expect(c.detail.toLowerCase(), c.id).not.toContain('spine');
    }
  });
});
