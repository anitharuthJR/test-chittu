/**
 * `/ops/users` — the counts, the names, and the writes.
 *
 * The console now identifies a family and can change or erase one, so the
 * properties worth pinning are the boundaries around that: no message body
 * anywhere, no id in a URL, no way to look a family up by email, a reason on
 * every write, the actor taken from the session rather than the form, an
 * append-only ledger that a band change versions rather than overwrites, and a
 * typed confirmation before anything is shredded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDb, localKeyProvider, type TestDb } from '@chittu/db';
import { buildServer } from '../server.js';
import { PER_PAGE, handle, pageNumber } from './users.js';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'u'.repeat(40);
const OPS = `arun@tulifo.ai=${TOKEN}`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let db: TestDb;
let app: FastifyInstance;
const keys = localKeyProvider(randomBytes(32), 'dev');

/**
 * ONE login for the whole file, and that is not just tidiness.
 *
 * `/ops/login` carries its own tighter rate limit — 10 in 5 minutes, because a
 * bearer token is guessable in principle and that route is the only place
 * guessing pays. Signing in per test quietly crossed it, and the symptom was
 * every later test failing on a missing cookie rather than on anything it was
 * testing. The 30-minute ops session outlives the file comfortably.
 */
let cookie: string;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({
    pool: db.pool, keys, logger: false, rateLimitMax: 100_000, opsTokens: OPS,
  });
  await app.ready();
  cookie = await signIn();
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); });

async function signIn(): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/ops/login', headers: FORM,
    payload: new URLSearchParams({ token: TOKEN }).toString(),
  });
  const c = r.cookies.find((x) => x.name === 'chittu_ops');
  expect(c, 'login must set the ops cookie').toBeDefined();
  return `chittu_ops=${c!.value}`;
}

let seq = 0;
/** The real enrolment path, so the rows are the rows the product writes. */
async function enrol(over: Record<string, unknown> = {}) {
  const d = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: {
      parentName: 'Lakshmi', parentEmail: `ops-users-${++seq}@example.com`,
      childFirstName: 'Meeraduraiswamy', country: 'IN',
      band: 'builder', board: 'CBSE', method: 'dev_stub',
      pin: '4917', pinConfirm: '4917', ...over,
    },
  });
  expect(d.statusCode, d.body).toBe(201);
  const { consentId } = d.json<{ consentId: string }>();
  const challengeId = d.json<{ challengeId: string }>().challengeId;
  const f = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId },
  });
  expect(f.statusCode, f.body).toBe(200);
  // The consent cookie the family's browser would hold, so a test can ask
  // whether an ops edit signed them out.
  const familyCookie = f.cookies.find((c) => c.name === 'chittu_consent')!.value;
  const { rows } = await db.pool.query<{ id: string; parent_id: string }>(
    `SELECT c.id, c.parent_id FROM child c
       JOIN consent_record cr ON cr.child_id = c.id WHERE cr.id = $1`, [consentId]);
  return {
    consentId, familyCookie,
    childId: rows[0]!.id, parentId: rows[0]!.parent_id,
  };
}

async function page(cookie: string, query = ''): Promise<string> {
  const r = await app.inject({ method: 'GET', url: `/ops/users${query}`, headers: { cookie } });
  expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
  return r.body;
}

describe('reachability', () => {
  it('does not exist when no operators are configured', async () => {
    const bare = await buildServer({ pool: db.pool, keys, logger: false, rateLimitMax: 100_000 });
    expect((await bare.inject({ method: 'GET', url: '/ops/users' })).statusCode).toBe(404);
    await bare.close();
  });

  it('shows the login form, not the counts, when signed out', async () => {
    const r = await app.inject({ method: 'GET', url: '/ops/users' });
    expect(r.statusCode).toBe(401);
    expect(r.body).toMatch(/sign in/i);
    expect(r.body).not.toMatch(/families/i);
  });

  it('is linked from the other console pages, not just typeable', async () => {
    for (const url of ['/ops/routing', '/ops/signals']) {
      const r = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(r.body, url).toContain('href="/ops/users"');
    }
  });
});

describe('what the page shows', () => {
  it('renders an empty console without a family', async () => {
    const body = await page(cookie);
    expect(body).toMatch(/No families yet/);
  });

  it('counts a family, its child, and its turns', async () => {
    const { childId, parentId } = await enrol();

    // A session with turns on it. Written directly: the counts this page reads
    // are `session.msg_count` and friends, and driving twelve turns through the
    // pipeline to move a counter would test the pipeline, not this page.
    await db.pool.query(
      `INSERT INTO session (child_id, consent_id, band, msg_count, spine_count,
                            crisis_lock, locked_at, read_attempts)
       SELECT $1, cr.id, 'builder', 12, 2, true, now(), 3
         FROM consent_record cr WHERE cr.child_id = $1 AND cr.status = 'active'`,
      [childId]);

    const body = await page(cookie);
    expect(body).toContain(handle(parentId));
    expect(body).toContain(handle(childId));
    expect(body).toMatch(/>12</);                       // turns
    expect(body).toMatch(/builder · IN/);
    expect(body).toMatch(/<span class="tag">active<\/span>/);
  });

  it('decrypts the parent name, the email and the child name', async () => {
    await enrol({
      parentName: 'Distinctivelakshmi', parentEmail: 'distinctive-parent@example.com',
      childFirstName: 'Distinctivemeera',
    });
    const body = await page(cookie);
    expect(body).toContain('Distinctivelakshmi');
    expect(body).toContain('distinctive-parent@example.com');
    expect(body).toContain('Distinctivemeera');
  });

  it('shows a dash, not a crash, when the key behind a name is shredded', async () => {
    const { childId } = await enrol({
      parentName: 'Shreddedparent', parentEmail: 'shredded@example.com',
      childFirstName: 'Shreddedchild',
    });
    await db.pool.query(
      `UPDATE child_data_key SET wrapped_dek = '\\x'::bytea, shredded_at = now()
        WHERE child_id = $1`, [childId]);

    const body = await page(cookie);          // 200, not 500
    expect(body).not.toContain('Shreddedchild');
    expect(body).not.toContain('shredded@example.com');
    expect(body).toContain('key shredded');
  });

  it('puts no id in a URL, anywhere on the page', async () => {
    const { childId, parentId } = await enrol();
    const body = await page(cookie);

    // Ids travel in POST bodies. A uuid in an href or a query string would be a
    // uuid in the access log, next to the caller's address.
    for (const href of body.match(/href="[^"]*"/g) ?? []) {
      expect(href, 'no uuid in a link').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
    expect(body).toMatch(new RegExp(`name="child_id" value="${childId}"`));
    expect(body).toMatch(new RegExp(`name="parent_id" value="${parentId}"`));
  });

  it('offers no way to look a family up', async () => {
    const body = await page(cookie);
    // The edit form has an email FIELD, which is not the same thing as a
    // lookup: `email_hash` is a blind index, and a box that resolves an address
    // to a family is an oracle for testing guessed addresses. So what must not
    // exist is a search control or a GET form that takes anything but a page.
    expect(body).not.toMatch(/<input[^>]+type="?search/i);
    expect(body).not.toMatch(/<form[^>]+method="get"/i);
    for (const href of body.match(/href="[^"]*"/g) ?? []) {
      expect(href).not.toMatch(/[?&](q|search|email|handle)=/i);
    }
  });

  it('reads no message row to produce a turn count', async () => {
    // A guard against the obvious "improvement". `message` is partitioned,
    // carries `body_enc`, and is the one table an ops query has no business in.
    const src = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('./users.ts', import.meta.url), 'utf8'));
    const sql = src.split('\n').filter((l) => !l.trimStart().startsWith('*')
      && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'));
    expect(sql.join('\n')).not.toMatch(/\bFROM message\b/i);
  });
});

describe('editing a family', () => {
  const post = (cookie: string, url: string, body: Record<string, string>) =>
    app.inject({
      method: 'POST', url, headers: { cookie, ...FORM },
      payload: new URLSearchParams(body).toString(),
    });

  it('corrects a parent name and email, and moves the blind index with it', async () => {
    const { parentId } = await enrol({ parentEmail: `typo${++seq}@exmaple.com` });

    const r = await post(cookie, '/ops/users/parent', {
      parent_id: parentId, name: 'Corrected Lakshmi', email: 'corrected@example.com',
      locale: 'en', reason: 'parent reported a typo in their address on the phone',
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.body).toContain('corrected@example.com');
    expect(r.body).toContain('Corrected Lakshmi');

    // The blind index moved too, so the parent is still findable by their email
    // — the whole point of writing both in one statement.
    const { fingerprint } = await import('@chittu/db');
    const hit = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM parent WHERE email_hash = $1 AND id = $2`,
      [fingerprint('corrected@example.com', await keys.indexKey()), parentId]);
    expect(hit.rows[0]!.n).toBe(1);
  });

  it('refuses an edit with no reason, and changes nothing', async () => {
    const { parentId } = await enrol({ parentName: 'Unchanged Name' });
    const r = await post(cookie, '/ops/users/parent', {
      parent_id: parentId, name: 'Overwritten', email: 'x@example.com',
      locale: 'en', reason: 'oops',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/incident review/i);
    expect(r.body).toContain('Unchanged Name');
    expect(r.body).not.toContain('Overwritten');
  });

  it('refuses an email another family already uses', async () => {
    await enrol({ parentEmail: 'taken@example.com' });
    const { parentId } = await enrol();
    const r = await post(cookie, '/ops/users/parent', {
      parent_id: parentId, name: 'L', email: 'taken@example.com', locale: 'en',
      reason: 'trying to merge two records the support desk raised',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/already uses that email/i);
  });

  it('takes the actor from the session, never from the form', async () => {
    const { parentId } = await enrol();
    await post(cookie, '/ops/users/parent', {
      parent_id: parentId, name: 'L', email: `actor${++seq}@example.com`, locale: 'en',
      reason: 'checking the audit records who really did this',
      actor: 'somebody-else@evil.example', operator: 'somebody-else@evil.example',
    });
    const { rows } = await db.pool.query<{ actor: string }>(
      `SELECT actor FROM ops_action WHERE subject_id = $1`, [parentId]);
    expect(rows[0]!.actor).toBe('arun@tulifo.ai');
  });

  it('a band change writes a NEW consent version and keeps the family signed in',
    async () => {
      const { childId, consentId, familyCookie } = await enrol({ band: 'explorer' });

      const r = await post(cookie, '/ops/users/child', {
        child_id: childId, first_name: 'Meera', band: 'builder', board: 'CBSE',
        reason: 'parent confirmed the age band was set wrong at signup',
      });
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);

      const rows = (await db.pool.query<{
        status: string; version: number; band: string;
        supersedes: string | null; token_hash: Buffer | null;
      }>(`SELECT status::text AS status, version, band::text AS band, supersedes, token_hash
            FROM consent_record WHERE child_id = $1 ORDER BY version ASC`, [childId])).rows;

      expect(rows, 'the ledger appends, it does not overwrite').toHaveLength(2);
      expect(rows[0]!.status).toBe('superseded');
      expect(rows[0]!.band).toBe('explorer');
      expect(rows[0]!.token_hash).toBeNull();
      expect(rows[1]!.status).toBe('active');
      expect(rows[1]!.band).toBe('builder');
      expect(rows[1]!.supersedes).toBe(consentId);
      expect(rows[1]!.token_hash).not.toBeNull();

      // THE PROPERTY THAT ACTUALLY BROKE. The rows can look perfect in SQL and
      // still be unusable: `assertActiveConsent` refuses a record whose seal
      // does not verify, so the only honest check is through the gate the child
      // goes through. The first implementation copied the OLD seal onto the new
      // row, every column above passed, and this returned {"active": false}.
      const status = await app.inject({
        method: 'GET', url: '/v1/consent/status',
        headers: { cookie: `chittu_consent=${familyCookie}` },
      });
      expect(status.json(), 'the correction must not sign the family out')
        .toMatchObject({ active: true, band: 'builder' });
    });

  it('a name change re-seals too — the name is inside the seal', async () => {
    const { childId, familyCookie } = await enrol({ childFirstName: 'Mispelt' });
    const r = await post(cookie, '/ops/users/child', {
      child_id: childId, first_name: 'Respelled', band: 'builder', board: 'CBSE',
      reason: 'parent said we spelled their child’s name wrong',
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.body).toContain('Respelled');

    // `canonicalise` hashes childFirstName, so a name edit that left the ledger
    // alone would leave a seal that no longer verifies — and a family locked out
    // of an account nobody can sign back into.
    const status = await app.inject({
      method: 'GET', url: '/v1/consent/status',
      headers: { cookie: `chittu_consent=${familyCookie}` },
    });
    expect(status.json()).toMatchObject({ active: true, childFirstName: 'Respelled' });
  });

  it('refuses in a sentence when a key will not open, rather than 500ing', async () => {
    const { childId, parentId } = await enrol();
    // A key that is PRESENT and NOT shredded and still will not open. In
    // production that is a CMK whose policy changed, a restore into an account
    // that cannot decrypt, or a `kms_key_arn` pointing at something retired;
    // here it is corrupted bytes, which fails at the same place.
    await db.pool.query(
      `UPDATE child_data_key SET wrapped_dek = $2 WHERE child_id = $1`,
      [childId, Buffer.alloc(60, 7)]);

    for (const [url, body] of [
      ['/ops/users/child', {
        child_id: childId, first_name: 'Meera', band: 'builder', board: 'CBSE',
        reason: 'an edit against a record whose key will not open',
      }],
      ['/ops/users/parent', {
        parent_id: parentId, name: 'L', email: `unopenable${++seq}@example.com`,
        locale: 'en', reason: 'an edit against a record whose key will not open',
      }],
    ] as const) {
      const r = await post(cookie, url, body as Record<string, string>);
      // 400 and a sentence, not 500 and "something went wrong" — an operator
      // who sees the latter retries; one who reads this escalates, which is the
      // correct next action.
      expect(r.statusCode, url).toBe(400);
      expect(r.body, url).toMatch(/encryption key cannot be opened/);
      expect(r.body, url).not.toMatch(/Something went wrong/);
    }
  });

  it('cannot move a family to another jurisdiction, even by hand-crafted POST',
    async () => {
      const { childId } = await enrol({ country: 'IN' });
      await post(cookie, '/ops/users/child', {
        child_id: childId, first_name: 'Meera', band: 'builder', board: 'CBSE',
        country: 'US', reason: 'trying to move the family to another jurisdiction',
      });
      const { rows } = await db.pool.query<{ country: string; law: string }>(
        `SELECT c.country::text AS country, cr.law FROM child c
           JOIN consent_record cr ON cr.child_id = c.id AND cr.status = 'active'
          WHERE c.id = $1`, [childId]);
      // `law` is chosen from the country at enrolment. Moving one without the
      // other would leave a record claiming consent under a law that does not
      // apply to this family, so the console does not offer it and does not
      // read it either.
      expect(rows[0]!.country).toBe('IN');
      expect(rows[0]!.law).toMatch(/DPDP/);
    });
});

describe('erasing a child', () => {
  const post = (cookie: string, body: Record<string, string>) =>
    app.inject({
      method: 'POST', url: '/ops/users/erase', headers: { cookie, ...FORM },
      payload: new URLSearchParams(body).toString(),
    });

  it('refuses without the typed handle, and erases nothing', async () => {
    const { childId } = await enrol();
    const r = await post(cookie, {
      child_id: childId, confirm: 'wrong',
      reason: 'parent asked us to close the account by email',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Nothing was erased/);
    const { rows } = await db.pool.query<{ shredded_at: Date | null }>(
      `SELECT shredded_at FROM child_data_key WHERE child_id = $1`, [childId]);
    expect(rows[0]!.shredded_at).toBeNull();
  });

  it('shreds the key, revokes the consent, and records who and why', async () => {
    const { childId } = await enrol({ childFirstName: 'Erasednow' });
    const r = await post(cookie, {
      child_id: childId, confirm: handle(childId),
      reason: 'parent asked us to close the account, verified on the phone',
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.body).toMatch(/key is shredded/);

    const key = await db.pool.query<{ shredded_at: Date | null; wrapped_dek: Buffer }>(
      `SELECT shredded_at, wrapped_dek FROM child_data_key WHERE child_id = $1`, [childId]);
    expect(key.rows[0]!.shredded_at).not.toBeNull();
    expect(key.rows[0]!.wrapped_dek).toHaveLength(0);

    const consent = await db.pool.query<{ status: string; token_hash: Buffer | null }>(
      `SELECT status::text AS status, token_hash FROM consent_record WHERE child_id = $1`,
      [childId]);
    expect(consent.rows.every((c) => c.status === 'revoked')).toBe(true);
    expect(consent.rows.every((c) => c.token_hash === null)).toBe(true);

    const audit = await db.pool.query<{ actor: string; action: string; reason: string }>(
      `SELECT actor, action, reason FROM ops_action WHERE subject_id = $1`, [childId]);
    expect(audit.rows[0]!.action).toBe('ERASE_CHILD');
    expect(audit.rows[0]!.actor).toBe('arun@tulifo.ai');

    // The name is gone from the page, and the audit did not keep a copy of it.
    expect(await page(cookie)).not.toContain('Erasednow');
    expect(audit.rows[0]!.reason).not.toContain('Erasednow');
  });

  it('the audit is append-only from the console — there is no route that edits it',
    async () => {
      const src = await import('node:fs/promises')
        .then((fs) => fs.readFile(new URL('./users.ts', import.meta.url), 'utf8'));
      expect(src).not.toMatch(/UPDATE ops_action|DELETE FROM ops_action/i);
    });
});

describe('pagination', () => {
  it('clamps a page number instead of failing on it', () => {
    expect(pageNumber(undefined, 3)).toBe(1);
    expect(pageNumber('abc', 3)).toBe(1);
    expect(pageNumber('0', 3)).toBe(1);
    expect(pageNumber('-4', 3)).toBe(1);
    expect(pageNumber('2', 3)).toBe(2);
    expect(pageNumber('999', 3)).toBe(3);
    // A console with nothing on it still has a page one.
    expect(pageNumber('999', 0)).toBe(1);
  });

  it('splits families across pages and links both ways', async () => {
        const before = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM parent');
    const want = PER_PAGE + 2 - before.rows[0]!.n;
    for (let i = 0; i < want; i++) await enrol();

    const one = await page(cookie);
    expect(one).toContain('page 1 of 2');
    expect(one).toContain('href="/ops/users?page=2"');
    expect((one.match(/class="fam"/g) ?? []).length).toBe(PER_PAGE);

    const two = await page(cookie, '?page=2');
    expect(two).toContain('page 2 of 2');
    expect(two).toContain('href="/ops/users?page=1"');
    expect((two.match(/class="fam"/g) ?? []).length).toBe(2);

    // Out of range shows the last page rather than an error or a blank table.
    expect(await page(cookie, '?page=99')).toContain('page 2 of 2');
    expect(await page(cookie, '?page=nonsense')).toContain('page 1 of 2');
  }, 120_000);
});
