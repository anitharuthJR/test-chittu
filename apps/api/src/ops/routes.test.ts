/**
 * The ops console over HTTP.
 *
 * The properties worth pinning are all about what is NOT reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, type TestDb } from '@chittu/db';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'z'.repeat(40);
const OPS = `arun@tulifo.ai=${TOKEN}`;

let db: TestDb;
const keys = localKeyProvider(randomBytes(32), 'dev');
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

async function server(opsTokens?: string): Promise<FastifyInstance> {
  return buildServer({
    pool: db.pool, keys, logger: false, rateLimitMax: 100_000,
    ...(opsTokens === undefined ? {} : { opsTokens }),
  });
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('the console does not exist unless it is configured', () => {
  it('404s every ops route with no CHITTU_OPS_TOKENS', async () => {
    const app = await server();
    for (const url of ['/ops', '/ops/routing', '/ops/users', '/ops/signals']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    for (const url of ['/ops/login', '/ops/signals/promote', '/ops/signals/examples',
      '/ops/examples/review']) {
      expect((await app.inject({ method: 'POST', url })).statusCode, url).toBe(404);
    }
    await app.close();
  });
});

describe('authentication', () => {
  it('shows a login form, not the console, when signed out', async () => {
    const app = await server(OPS);
    const r = await app.inject({ method: 'GET', url: '/ops' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/sign in/i);
    expect(r.body).not.toMatch(/claude-sonnet-5/);
    await app.close();
  });

  it('refuses a wrong token and sets no cookie', async () => {
    const app = await server(OPS);
    const r = await app.inject({
      method: 'POST', url: '/ops/login', headers: FORM, payload: form({ token: 'nope' }),
    });
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('accepts the right token and sets an httpOnly cookie scoped to /ops', async () => {
    const app = await server(OPS);
    const r = await app.inject({
      method: 'POST', url: '/ops/login', headers: FORM, payload: form({ token: TOKEN }),
    });
    expect(r.statusCode).toBe(303);
    const c = String(r.headers['set-cookie']);
    expect(c).toMatch(/chittu_ops=/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Path=\/ops/i);
    await app.close();
  });

  it('the routing console requires a session', async () => {
    const app = await server(OPS);
    const r = await app.inject({ method: 'GET', url: '/ops/routing' });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('a CHILD\'s consent cookie is not an ops session', async () => {
    const app = await server(OPS);
    const r = await app.inject({
      method: 'GET', url: '/ops/routing',
      cookies: { chittu_consent: 'whatever-a-child-holds' },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});

describe('writing a routing change', () => {
  async function signedIn(app: FastifyInstance) {
    const r = await app.inject({
      method: 'POST', url: '/ops/login', headers: FORM, payload: form({ token: TOKEN }),
    });
    const raw = String(r.headers['set-cookie']).split(';')[0]!;
    return { chittu_ops: raw.slice(raw.indexOf('=') + 1) };
  }

  it('requires a session', async () => {
    const app = await server(OPS);
    const r = await app.inject({
      method: 'POST', url: '/ops/routing', headers: FORM,
      payload: form({ category: 'sandbox', pair: 'anthropic:claude-opus-5', reason: 'a good reason' }),
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('records changed_by from the SESSION, never from the form', async () => {
    const app = await server(OPS);
    const cookies = await signedIn(app);
    const r = await app.inject({
      method: 'POST', url: '/ops/routing', headers: FORM, cookies,
      payload: form({
        category: 'sandbox', pair: 'anthropic:claude-opus-5',
        reason: 'escalating for the evening peak',
        // A hostile form field. It must be ignored.
        changed_by: 'somebody-else@evil.example',
      }),
    });
    expect(r.statusCode).toBe(303);
    const { rows } = await db.pool.query<{ changed_by: string }>(
      `SELECT changed_by FROM provider_cell ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.changed_by).toBe('arun@tulifo.ai');
    await app.close();
  });

  it('refuses a model that is not in the compiled catalogue', async () => {
    const app = await server(OPS);
    const cookies = await signedIn(app);
    const before = await db.pool.query(`SELECT count(*)::int AS n FROM provider_cell`);
    const r = await app.inject({
      method: 'POST', url: '/ops/routing', headers: FORM, cookies,
      payload: form({
        category: 'sandbox', pair: 'anthropic:gpt-5', reason: 'trying something out',
      }),
    });
    expect(r.statusCode).toBe(400);
    const after = await db.pool.query(`SELECT count(*)::int AS n FROM provider_cell`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    await app.close();
  });

  it('refuses an unexplained change', async () => {
    const app = await server(OPS);
    const cookies = await signedIn(app);
    const r = await app.inject({
      method: 'POST', url: '/ops/routing', headers: FORM, cookies,
      payload: form({ category: 'sandbox', pair: 'anthropic:claude-opus-5', reason: 'x' }),
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('escapes what it renders — a reason cannot inject markup', async () => {
    const app = await server(OPS);
    const cookies = await signedIn(app);
    await app.inject({
      method: 'POST', url: '/ops/routing', headers: FORM, cookies,
      payload: form({
        category: 'homework', pair: 'anthropic:claude-opus-5',
        reason: 'why <script>alert(1)</script> matters',
      }),
    });
    const page = await app.inject({ method: 'GET', url: '/ops/routing', cookies });
    expect(page.body).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(page.body).toMatch(/&lt;script&gt;/);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// /ops/signals — phase 4
// ---------------------------------------------------------------------------

const TOKEN_B = 'y'.repeat(40);
const TWO_OPS = `${OPS},grace@tulifo.ai=${TOKEN_B}`;

/** Sign in and return a cookie jar. */
async function signIn(app: FastifyInstance, token: string) {
  const r = await app.inject({
    method: 'POST', url: '/ops/login', headers: FORM, payload: form({ token }) });
  const raw = String(r.headers['set-cookie']).split(';')[0]!;
  return { chittu_ops: raw.slice(raw.indexOf('=') + 1) };
}

/** Drive N distinct sessions of one shape straight through the repo. */
async function seed(shape: string, n: number) {
  const { signalRepo } = await import('@chittu/db');
  const key = await keys.indexKey();
  for (let i = 0; i < n; i += 1) {
    await signalRepo.observe(db.pool, {
      shape, layer: 'L5_SANDBOX', observedToken: 'CRISIS',
      failureClass: null, band: 'builder', country: 'IN',
    }, randomUUID(), key);
  }
}

describe('the signals queue', () => {
  it('shows a shape that reached the floor', async () => {
    const shape = 'my <PET> died and i feel <EMOTION>';
    await seed(shape, 25);
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const r = await app.inject({ method: 'GET', url: '/ops/signals', cookies });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('my &lt;PET&gt; died and i feel &lt;EMOTION&gt;');
    await app.close();
  });

  /**
   * THE ONE THAT MATTERS. At k=1 a counter row already carries band, country,
   * observed_token and first_seen_at, all written on the first sighting — one
   * child's turn described in facets and timestamped to the second. The floor
   * is enforced on the READ path too, and this proves the sweep can see the
   * difference rather than reporting all-clear about a page it never rendered.
   */
  it('shows NOTHING about a sub-floor shape — not the shape, not its facets', async () => {
    const shape = 'i want to be a <OOV> in <PLACE>';
    await seed(shape, 1);
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const r = await app.inject({ method: 'GET', url: '/ops/signals', cookies });
    const { shapeHash } = await import('@chittu/db');
    const handle = shapeHash(shape, await keys.indexKey()).toString('hex');

    expect(r.body).not.toContain('&lt;OOV&gt; in &lt;PLACE&gt;');
    expect(r.body).not.toContain(handle);
    // The positive control: the page DOES render an above-floor shape and its
    // handle, so the three assertions above are looking somewhere real.
    const ready = 'my <PET> died and i feel <EMOTION>';
    await seed(ready, 25);
    const r2 = await app.inject({ method: 'GET', url: '/ops/signals', cookies });
    expect(r2.body).toContain('my &lt;PET&gt; died and i feel &lt;EMOTION&gt;');
    expect(r2.body).toContain(shapeHash(ready, await keys.indexKey()).toString('hex'));
    await app.close();
  });

  it('reports sub-floor volume as one number and never as rows', async () => {
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const r = await app.inject({ method: 'GET', url: '/ops/signals', cookies });
    expect(r.body).toMatch(/shapes? (is|are) being counted/);
    await app.close();
  });

  it('needs a session', async () => {
    const app = await server(TWO_OPS);
    const r = await app.inject({ method: 'GET', url: '/ops/signals' });
    expect(r.statusCode).toBe(401);
    expect(r.body).toMatch(/sign in/i);
    await app.close();
  });
});

describe('triage and authoring take their identity from the SESSION', () => {
  const shape = 'what is <NUM> plus <NUM>';

  it('ignores an authored_by in the body', async () => {
    await seed(shape, 25);
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const { shapeHash } = await import('@chittu/db');
    const handle = shapeHash(shape, await keys.indexKey()).toString('hex');

    const promoted = await app.inject({
      method: 'POST', url: '/ops/signals/promote', headers: FORM, cookies,
      payload: form({ handle, failure_class: 'OVER_REFUSAL', expected_token: 'NONE' }) });
    expect(promoted.statusCode).toBe(303);

    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM training_signal WHERE shape = $1`, [shape]);
    const signalId = rows[0]!.id;

    const authored = await app.inject({
      method: 'POST', url: '/ops/signals/examples', headers: FORM, cookies,
      payload: form({
        signal_id: signalId, slice: 'maths', prompt: 'what is 7 plus 5',
        completion: 'Twelve! Want another?', label: 'SAFE', split: 'train',
        // All three of these are ignored. The database would accept every one.
        authored_by: 'somebody-else@evil.example',
        origin: 'DISTILLED', state: 'APPROVED',
      }) });
    expect(authored.statusCode).toBe(303);

    const e = await db.pool.query<{ authored_by: string; origin: string; state: string }>(
      `SELECT authored_by, origin::text AS origin, state::text AS state
         FROM training_example WHERE signal_id = $1`, [signalId]);
    expect(e.rows[0]).toEqual({
      authored_by: 'arun@tulifo.ai', origin: 'AUTHORED', state: 'PENDING_HUMAN_REVIEW',
    });
    await app.close();
  });
});

describe('four eyes, over HTTP', () => {
  it('refuses the author, accepts the other operator', async () => {
    const shape = 'i am really <EMOTION> about the <OOV> tomorrow';
    await seed(shape, 25);
    const app = await server(TWO_OPS);
    const { shapeHash } = await import('@chittu/db');
    const handle = shapeHash(shape, await keys.indexKey()).toString('hex');

    const asArun = await signIn(app, TOKEN);
    await app.inject({
      method: 'POST', url: '/ops/signals/promote', headers: FORM, cookies: asArun,
      payload: form({ handle, failure_class: 'OVER_REFUSAL', expected_token: 'NONE' }) });
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM training_signal WHERE shape = $1`, [shape]);
    await app.inject({
      method: 'POST', url: '/ops/signals/examples', headers: FORM, cookies: asArun,
      payload: form({
        signal_id: rows[0]!.id, slice: 'exam-nerves',
        prompt: 'i am nervous about the test tomorrow',
        completion: 'Nerves before a test are normal. What is the first thing you will revise?',
        label: 'SAFE', split: 'train' }) });
    const e = await db.pool.query<{ id: string }>(
      `SELECT id FROM training_example WHERE signal_id = $1`, [rows[0]!.id]);
    const exampleId = e.rows[0]!.id;

    // The author cannot approve their own.
    const own = await app.inject({
      method: 'POST', url: '/ops/examples/review', headers: FORM, cookies: asArun,
      payload: form({ example_id: exampleId, state: 'APPROVED' }) });
    expect(own.statusCode).toBe(400);
    expect(own.body).toMatch(/second pair of eyes/);

    // And the page does not even offer them the button.
    const page = await app.inject({ method: 'GET', url: '/ops/signals', cookies: asArun });
    expect(page.body).toMatch(/yours — needs someone else/);

    // Somebody else can.
    const asGrace = await signIn(app, TOKEN_B);
    const other = await app.inject({
      method: 'POST', url: '/ops/examples/review', headers: FORM, cookies: asGrace,
      payload: form({ example_id: exampleId, state: 'APPROVED' }) });
    expect(other.statusCode).toBe(303);
    const after = await db.pool.query<{ state: string; reviewed_by: string }>(
      `SELECT state::text AS state, reviewed_by FROM training_example WHERE id = $1`,
      [exampleId]);
    expect(after.rows[0]).toEqual({ state: 'APPROVED', reviewed_by: 'grace@tulifo.ai' });
    await app.close();
  });

  it('says so plainly when only one operator is configured', async () => {
    const app = await server(OPS);
    const cookies = await signIn(app, TOKEN);
    const r = await app.inject({ method: 'GET', url: '/ops/signals', cookies });
    expect(r.body).toMatch(/Only one operator is configured/);
    const post = await app.inject({
      method: 'POST', url: '/ops/examples/review', headers: FORM, cookies,
      payload: form({ example_id: randomUUID(), state: 'APPROVED' }) });
    expect(post.statusCode).toBe(400);
    await app.close();
  });
});

describe('the console never leaks a sub-floor count', () => {
  /**
   * `promote()` throws "below the k-anonymity floor: 7 of 25 sessions" — the
   * exact number the floor exists to withhold. Fastify's default error handler
   * would have put it in a JSON body with no CSP header, because the app's own
   * handler is registered on the root instance AFTER this plugin.
   */
  it('answers a promote for a sub-floor shape in HTML, with no count', async () => {
    const shape = 'i live in <PLACE> with my <PET>';
    await seed(shape, 3);
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const { shapeHash } = await import('@chittu/db');
    const r = await app.inject({
      method: 'POST', url: '/ops/signals/promote', headers: FORM, cookies,
      payload: form({
        handle: shapeHash(shape, await keys.indexKey()).toString('hex'),
        failure_class: 'OVER_REFUSAL', expected_token: 'NONE' }) });
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toBeTruthy();
    expect(r.body).not.toMatch(/\d+ of 25/);
    expect(r.body).not.toMatch(/k-anonymity floor/);
    await app.close();
  });
});

describe('operator text is escaped like everything else', () => {
  it('does not render a script tag typed into a completion', async () => {
    const shape = 'why is the <OOV> blue';
    await seed(shape, 25);
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const { shapeHash } = await import('@chittu/db');
    await app.inject({
      method: 'POST', url: '/ops/signals/promote', headers: FORM, cookies,
      payload: form({
        handle: shapeHash(shape, await keys.indexKey()).toString('hex'),
        failure_class: 'QUALITY_DEGRADED', expected_token: 'NONE' }) });
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM training_signal WHERE shape = $1`, [shape]);
    await app.inject({
      method: 'POST', url: '/ops/signals/examples', headers: FORM, cookies,
      payload: form({
        signal_id: rows[0]!.id, slice: 'science', prompt: 'why is the sky blue',
        completion: '<script>alert(1)</script>', label: 'SAFE', split: 'train' }) });
    const page = await app.inject({ method: 'GET', url: '/ops/signals', cookies });
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&lt;script&gt;');
    await app.close();
  });
});

describe('every signals route needs a session', () => {
  /**
   * Removing the `who()` check from the promote route broke ZERO tests when it
   * was first written — the queue's own auth test covered the GET and nothing
   * covered the three POSTs. A guard whose removal is silent is not a guard.
   */
  it.each([
    ['/ops/signals/promote', { handle: 'a'.repeat(64), failure_class: 'OVER_REFUSAL', expected_token: 'NONE' }],
    ['/ops/signals/examples', { signal_id: 'x', slice: 'maths', prompt: 'p', completion: 'c', split: 'train' }],
    ['/ops/examples/review', { example_id: 'x', state: 'APPROVED' }],
  ])('%s refuses without a cookie, and writes nothing', async (url, payload) => {
    const app = await server(TWO_OPS);
    const before = await db.pool.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM training_signal)
            + (SELECT count(*) FROM training_example) AS n`);
    const r = await app.inject({
      method: 'POST', url, headers: FORM, payload: form(payload as Record<string, string>) });
    expect(r.statusCode).toBe(401);
    expect(r.body).toMatch(/sign in/i);
    const after = await db.pool.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM training_signal)
            + (SELECT count(*) FROM training_example) AS n`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    await app.close();
  });
});

describe('an unexpected failure is still HTML, and still says nothing', () => {
  /**
   * The routes catch what they expect — a duplicate, a same-eyes review, a
   * sub-floor promote. The error handler is for what they do not, and removing
   * it broke zero tests until this one existed: Fastify's default would answer
   * with a JSON body carrying `err.message` verbatim and no CSP header, because
   * the application's own handler is registered on the root instance AFTER this
   * plugin.
   */
  it('a malformed signal id renders the console, not a database message', async () => {
    const app = await server(TWO_OPS);
    const cookies = await signIn(app, TOKEN);
    const r = await app.inject({
      method: 'POST', url: '/ops/signals/examples', headers: FORM, cookies,
      payload: form({
        signal_id: 'not-a-uuid', slice: 'maths', prompt: 'a prompt',
        completion: 'an answer', label: 'SAFE', split: 'train' }) });
    expect(r.statusCode).toBe(500);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toBeTruthy();
    // Postgres says "invalid input syntax for type uuid: \"not-a-uuid\"".
    // The operator gets a sentence; the detail goes to the log.
    expect(r.body).not.toMatch(/invalid input syntax|uuid|not-a-uuid/i);
    expect(r.body).toMatch(/in the log rather than on this page/);
    await app.close();
  });
});
