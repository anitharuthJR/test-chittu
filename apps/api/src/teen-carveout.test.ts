/**
 * "A teen's message body can never be stored" — everywhere, not one column.
 *
 * Session 001's ruling is enforced by a CHECK on `message`, and
 * `packages/db/src/child-repo.ts` agrees with it before the constraint has to
 * argue. `session.runtime_enc` did not: it carries `history` (the model's
 * context) and `recentKid` (the classifier's window), both of which are the
 * child's own sentences, and both survived a full write-and-read cycle.
 *
 * So the sweep here does not look at a column somebody nominated. It drives
 * real turns and then asks the database whether the child's words are anywhere
 * in it — decrypting the blob the way the application does, because a
 * ciphertext grep proves nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { buildServer } from './server.js';
import type { ProviderRouter } from './providers.js';
import type { FastifyInstance } from 'fastify';
import type { Band } from '@chittu/contracts';

const keys = localKeyProvider(randomBytes(32), 'dev');
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { fixture = await createTestDb(); pool = fixture.pool; }, 120_000);
afterAll(async () => { await fixture?.close(); });

/** Records everything handed to a vendor, so "next turn" leaks are visible. */
/** What a model could put in `assist` — `parseAssist` accepts any non-empty string. */
const ASSIST = 'BIG-QUESTION: bananabread and what a locker code is';

function spy() {
  const sent: string[] = [];
  const r: ProviderRouter = {
    route: (c) => ({ provider: 'anthropic', model: 'm', promptVersion: `${c}-v1` }),
    async classify(text, recentKid) {
      sent.push(JSON.stringify([...recentKid, text]));
      return { label: 'SAFE', memory: null, assist: ASSIST };
    },
    async generate(input) {
      sent.push(JSON.stringify(input.state.history));
      return 'A fine answer.';
    },
  };
  return { router: r, sent };
}

async function open_(app: FastifyInstance, band: Band) {
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: { parentName: 'P', parentEmail: `c-${randomUUID()}@example.com`,
      childFirstName: 'C', country: 'IN', band, method: 'dev_stub',
      pin: '2846', pinConfirm: '2846' } });
  const { consentId, challengeId } = draft.json() as { consentId: string; challengeId: string };
  const fin = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId } });
  const raw = String(fin.headers['set-cookie']).split(';')[0]!;
  const cookies = { chittu_consent: raw.slice(raw.indexOf('=') + 1) };
  const sess = await app.inject({ method: 'POST', url: '/v1/session', cookies, payload: {} });
  return { cookies, sessionId: (sess.json() as { sessionId: string }).sessionId };
}

/** The runtime blob, decrypted exactly as the application decrypts it. */
async function runtimeBlob(sessionId: string, childId: string) {
  const { decrypt } = await import('@chittu/db');
  const r = await pool.query<{ runtime_enc: Buffer | null }>(
    `SELECT runtime_enc FROM session WHERE id = $1`, [sessionId]);
  const blob = r.rows[0]?.runtime_enc;
  if (!blob) return null;
  const k = await pool.query<{ wrapped_dek: Buffer }>(
    `SELECT wrapped_dek FROM child_data_key WHERE child_id = $1`, [childId]);
  const dek = await keys.unwrap(Buffer.from(k.rows[0]!.wrapped_dek), 'local:dev-master');
  return decrypt(Buffer.from(blob), dek) as string;
}

const SECRET = 'my locker code is bananabread and i told nobody';

async function drive(band: Band) {
  const s = spy();
  const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
  const { cookies, sessionId } = await open_(app, band);
  const owner = await pool.query<{ child_id: string }>(
    `SELECT child_id FROM session WHERE id = $1`, [sessionId]);
  await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
    payload: { text: SECRET } });
  await app.close();

  // A SECOND process, so nothing survives in memory — only what the database
  // handed back. This is the round trip that matters.
  const s2 = spy();
  const app2 = await buildServer({ pool, keys, router: s2.router, rateLimitMax: 100_000 });
  await app2.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
    payload: { text: 'what is photosynthesis' } });
  await app2.close();

  return {
    blob: await runtimeBlob(sessionId, owner.rows[0]!.child_id),
    sentOnTurnTwo: s2.sent,
    bodies: Number((await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message
        WHERE session_id = $1 AND body_enc IS NOT NULL`, [sessionId])).rows[0]!.n),
  };
}

describe("a thinker's words are nowhere in the database", () => {
  it('not in message, not in the runtime blob, not on the next turn', async () => {
    const r = await drive('thinker');
    expect(r.bodies, 'a teen message row carried a body').toBe(0);
    expect(r.blob ?? '', 'the runtime blob held the teen\'s words').not.toContain('bananabread');
    expect(r.sentOnTurnTwo.filter((c) => c.includes('bananabread')),
      'turn two handed a vendor what turn one said').toEqual([]);
  }, 120_000);

  it('the blob still exists and still carries the non-text state', async () => {
    // Emptying it entirely would lose mathPractice, topics and lastSubject —
    // a different bug wearing this fix as a disguise.
    const r = await drive('thinker');
    expect(r.blob).not.toBeNull();
    expect(JSON.parse(r.blob!)).toMatchObject({ history: [], recentKid: [] });
    // The whole shape, so a field added later has to be argued for here first —
    // this blob is the one place a teen's words got written down, and the way
    // that happened was a field arriving without anyone asking what it carried.
    expect(Object.keys(JSON.parse(r.blob!)).sort())
      .toEqual(['assists', 'history', 'lastSubject', 'mathPractice', 'recentKid', 'topics']);
  }, 120_000);
});

describe('the assist array is persisted for nobody, because nothing reads it', () => {
  it('is always empty on the way back, whatever the classifier returned', async () => {
    // `parseAssist` accepts any non-empty string the model sends, and this
    // array had no CHECK behind it — unlike `flag.assist_topic`, which is
    // constrained to `^[a-z0-9 -]{1,40}$` so it cannot become free text.
    const r = await drive('builder');
    expect(JSON.parse(r.blob!).assists).toEqual([]);
    // And the string the classifier actually returned is nowhere in the blob —
    // the assertion above would pass on an empty array for any reason.
    expect(r.blob!, 'the assist survived into the blob').not.toContain('BIG-QUESTION');
  }, 120_000);
});

describe('and the other bands are unchanged — this is a carve-out, not a deletion', () => {
  it.each(['explorer', 'builder'] as const)('%s keeps its context across a restart', async (band) => {
    const r = await drive(band);
    expect(r.bodies, 'a message body should have been stored').toBeGreaterThan(0);
    expect(r.blob ?? '').toContain('bananabread');
    // The POSITIVE CONTROL for the test above: this is the same sweep, on the
    // same words, finding them. An all-clear from an instrument that cannot
    // find anything is this repo's most-repeated failure.
    expect(r.sentOnTurnTwo.some((c) => c.includes('bananabread')),
      'the sweep found nothing even where the words ARE stored').toBe(true);
  }, 120_000);
});
