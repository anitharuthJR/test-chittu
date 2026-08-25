/**
 * The ops console over HTTP.
 *
 * The properties worth pinning are all about what is NOT reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
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
    for (const url of ['/ops', '/ops/routing']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/ops/login' })).statusCode).toBe(404);
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
