/**
 * A child shows Chittu a picture — D2's IMG attach, D3's "pictures the child
 * shows", and D4's fourth crisis detector, end to end through the real route.
 *
 * TWO CLAIMS ARE TESTED HERE AND THEY ARE THE WHOLE FEATURE.
 *
 * **The picture is never stored.** Not in `message`, not in
 * `session.runtime_enc`, not in the seal chain, not in a flag, not anywhere.
 * The sweep below does not check a column somebody nominated: it asks the
 * database for every text column it has and greps all of them, and it decrypts
 * the two encrypted blobs the way the application does, because a ciphertext
 * grep proves nothing. It carries a positive control, for the reason CLAUDE.md
 * gives — a sweep that finds nothing looks exactly like one looking in the
 * wrong place, and three instruments in this repo have already reported success
 * while measuring something else.
 *
 * **An upsetting picture escalates.** Same lock, same script, same helplines,
 * same category-only flag as a crisis typed in words. A vision path that cannot
 * escalate is worse than no vision path, because it opens the channel a child
 * in trouble is most likely to use without words and then answers it as though
 * it were a drawing of a cat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDb, localKeyProvider, type DbPool } from '@chittu/db';
import { IMAGE_MAX_BASE64_CHARS } from '@chittu/contracts';
import type { ImageInput } from '@chittu/contracts';
import { buildServer } from './server.js';
import type { ProviderRouter } from './providers.js';
import type { SandboxInput } from '@chittu/pipeline';
import type { FastifyInstance } from 'fastify';

const keys = localKeyProvider(randomBytes(32), 'dev');
let pool: DbPool;
let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { fixture = await createTestDb(); pool = fixture.pool; }, 120_000);
afterAll(async () => { await fixture?.close(); });

/**
 * The needle. Valid base64, and a string that survives no encoding, no
 * abstraction and no truncation — which is what makes "it is not in the
 * database" mean something.
 */
const PIXELS = 'cGljdHVyZXp6enp6bmVlZGxlcGF5bG9hZA';
const picture: ImageInput = { mimeType: 'image/png', dataBase64: PIXELS };

function spy(reply = 'A lovely drawing! [CHIPS]Another[/CHIPS]') {
  const sandboxSaw: SandboxInput[] = [];
  const metered: string[] = [];
  const router: ProviderRouter = {
    route: (c) => ({ provider: 'anthropic', model: 'claude-sonnet-5', promptVersion: `${c}-v1` }),
    async classify(_t, _h, _ctx, onUsage) {
      onUsage?.({ category: 'classifier', provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001', promptVersion: 'classifier-v1',
        tokensIn: 700, tokensOut: 5, latencyMs: 20 });
      return { label: 'SAFE', memory: null, assist: null };
    },
    async generate(input, onUsage) {
      sandboxSaw.push(input);
      // The category the ROUTER would choose, reproduced here so the metering
      // assertion is about the pipeline reaching a vision call rather than
      // about this stub's opinion. router.test.ts owns the choice itself.
      const category = input.image !== undefined ? 'vision' as const : 'sandbox' as const;
      metered.push(category);
      onUsage?.({ category, provider: 'anthropic', model: 'claude-sonnet-5',
        promptVersion: 'sandbox-v1', tokensIn: 1400, tokensOut: 90, latencyMs: 800 });
      return reply;
    },
  };
  return { router, sandboxSaw, metered };
}

async function open_(app: FastifyInstance) {
  const draft = await app.inject({
    method: 'POST', url: '/v1/consent/draft',
    payload: { parentName: 'P', parentEmail: `v-${randomUUID()}@example.com`,
      childFirstName: 'C', country: 'IN', band: 'builder', method: 'dev_stub',
      pin: '2846', pinConfirm: '2846' } });
  const { consentId, challengeId } = draft.json() as { consentId: string; challengeId: string };
  const fin = await app.inject({
    method: 'POST', url: `/v1/consent/${consentId}/finalize`, payload: { challengeId } });
  const raw = String(fin.headers['set-cookie']).split(';')[0]!;
  const cookies = { chittu_consent: raw.slice(raw.indexOf('=') + 1) };
  const sess = await app.inject({ method: 'POST', url: '/v1/session', cookies, payload: {} });
  const sessionId = (sess.json() as { sessionId: string }).sessionId;
  const owner = await pool.query<{ child_id: string }>(
    `SELECT child_id FROM session WHERE id = $1`, [sessionId]);
  return { cookies, sessionId, childId: owner.rows[0]!.child_id };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Every text column in the schema, greped for each needle. */
async function grepTextColumns(needles: readonly string[]): Promise<string[]> {
  const cols = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text','character varying')`);
  expect(cols.rows.length, 'the sweep found no columns to look in').toBeGreaterThan(10);
  const hits: string[] = [];
  for (const c of cols.rows) {
    for (const n of needles) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${c.table_name}
          WHERE ${c.column_name} IS NOT NULL AND ${c.column_name} LIKE $1`, [`%${n}%`]);
      if (r.rows[0]!.n !== '0') hits.push(`${c.table_name}.${c.column_name} ~ ${n}`);
    }
  }
  return hits;
}

/**
 * The two ENCRYPTED stores, decrypted the way the application decrypts them.
 *
 * A grep of the ciphertext would pass against a database that had the picture
 * in it, which is the failure mode this whole file exists to rule out.
 */
async function decryptedStores(sessionId: string, childId: string): Promise<string> {
  const { decrypt, toBuffer } = await import('@chittu/db');
  const k = await pool.query<{ wrapped_dek: Buffer }>(
    `SELECT wrapped_dek FROM child_data_key WHERE child_id = $1`, [childId]);
  const dek = await keys.unwrap(Buffer.from(k.rows[0]!.wrapped_dek), 'local:dev-master');

  const s = await pool.query<{ runtime_enc: Buffer | null }>(
    `SELECT runtime_enc FROM session WHERE id = $1`, [sessionId]);
  const blob = s.rows[0]?.runtime_enc;

  const m = await pool.query<{ body_enc: Buffer | null }>(
    `SELECT body_enc FROM message WHERE session_id = $1 ORDER BY seq`, [sessionId]);

  return [
    blob ? decrypt(toBuffer(blob), dek) : '',
    ...m.rows.map((r) => (r.body_enc ? decrypt(toBuffer(r.body_enc), dek) : '')),
  ].join('\n');
}

// ---------------------------------------------------------------------------

describe('the route accepts a picture — widened, not loosened', () => {
  it('takes {text, image} and answers', async () => {
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image: picture } });
    expect(r.statusCode).toBe(200);
    expect(s.sandboxSaw[0]!.image).toEqual(picture);
    await app.close();
  });

  it.each([
    ['an unknown mime type', { mimeType: 'image/tiff', dataBase64: PIXELS }],
    ['a data: URI rather than base64', { mimeType: 'image/png', dataBase64: `data:image/png;base64,${PIXELS}` }],
    ['a payload past the cap', { mimeType: 'image/png', dataBase64: 'A'.repeat(IMAGE_MAX_BASE64_CHARS + 4) }],
    ['a missing mime type', { dataBase64: PIXELS }],
    ['an extra field inside the image', { mimeType: 'image/png', dataBase64: PIXELS, filename: 'x.png' }],
  ])('refuses %s', async (_label, image) => {
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image } });
    expect(r.statusCode).toBe(400);
    expect(s.sandboxSaw, 'a refused picture still reached a vendor').toEqual([]);
    await app.close();
  });

  it('still refuses an unknown top-level field — additionalProperties stayed false', async () => {
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'hi', image: picture, deviceId: 'abc-123' } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('a vision call is metered like any other model call', async () => {
    await pool.query('DELETE FROM metering');
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image: picture } });
    const { rows } = await pool.query<{ call_type: string; cost_usd: string }>(
      `SELECT call_type, cost_usd FROM metering ORDER BY id`);
    expect(rows.map((r) => r.call_type).sort()).toEqual(['classifier', 'vision']);
    expect(Number(rows.find((r) => r.call_type === 'vision')!.cost_usd)).toBeGreaterThan(0);
    await app.close();
  });
});

// ---------------------------------------------------------------------------

describe('THE PICTURE IS NEVER STORED', () => {
  it('the sweep can find things — positive control', async () => {
    // The needle here is the child's TEXT, which IS stored for a builder. If
    // this does not turn up, the negative results below are meaningless.
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId, childId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'look at my volcanoquokka drawing', image: picture } });
    await app.close();

    expect(await decryptedStores(sessionId, childId),
      'the sweep is not reaching the stored bodies at all')
      .toContain('volcanoquokka');
    expect((await grepTextColumns(['chat'])).filter((h) => h.includes('.mode ~ chat')),
      'the text-column sweep is not reaching any rows').not.toEqual([]);
  }, 120_000);

  it('is in NO text column anywhere in the schema', async () => {
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image: picture } });
    await app.close();
    expect(await grepTextColumns([PIXELS, 'image/png'])).toEqual([]);
  }, 120_000);

  it('is in NEITHER encrypted store — message bodies nor the runtime blob', async () => {
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId, childId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image: picture } });
    await app.close();

    const plain = await decryptedStores(sessionId, childId);
    expect(plain, 'the picture survived into an encrypted store').not.toContain(PIXELS);
    expect(plain).not.toContain('image/png');
  }, 120_000);

  it('the runtime blob has no new key — nothing was added to argue for', async () => {
    // `teen-carveout.test.ts` pins this key set, and it does so because a field
    // arriving without anyone asking what it carried is exactly how `history`
    // got in. Asserted here too, from the picture's side.
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId, childId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image: picture } });
    await app.close();

    const { decrypt, toBuffer } = await import('@chittu/db');
    const k = await pool.query<{ wrapped_dek: Buffer }>(
      `SELECT wrapped_dek FROM child_data_key WHERE child_id = $1`, [childId]);
    const dek = await keys.unwrap(Buffer.from(k.rows[0]!.wrapped_dek), 'local:dev-master');
    const b = (await pool.query<{ runtime_enc: Buffer }>(
      `SELECT runtime_enc FROM session WHERE id = $1`, [sessionId])).rows[0]!.runtime_enc;
    expect(Object.keys(JSON.parse(decrypt(toBuffer(b), dek))).sort())
      .toEqual(['assists', 'history', 'lastSubject', 'mathPractice', 'recentKid', 'topics']);
  }, 120_000);

  it('the seal chain records THAT a picture was shown and nothing of what it held',
    async () => {
      const s = spy();
      const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
      const { cookies, sessionId } = await open_(app);
      await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
        payload: { text: 'what is this?', image: picture } });

      // `audit_event` has a payload_hash and no payload column at all — the
      // chain evidences what was said without keeping it. Swept anyway, because
      // "the schema cannot hold it" is a claim about the schema and this is a
      // claim about the rows.
      const { rows } = await pool.query<{ layer: string; payload_hash: string }>(
        `SELECT layer, payload_hash FROM audit_event WHERE session_id = $1 ORDER BY seq`,
        [sessionId]);
      expect(JSON.stringify(rows), 'the seal chain carried image bytes')
        .not.toContain(PIXELS);
      expect(rows.some((r) => r.layer === 'INPUT\u00B7IMAGE'),
        'nothing recorded that a picture was shown').toBe(true);

      // And the chain still verifies — an extra record must not fork it.
      const v = await app.inject({ method: 'GET', url: `/v1/session/${sessionId}/seal` });
      expect((v.json() as { ok: boolean }).ok).toBe(true);
      await app.close();
    }, 120_000);

  it('does not ride the NEXT turn, across a full restart', async () => {
    const s = spy();
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId } = await open_(app);
    await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'what is this?', image: picture } });
    await app.close();

    // A second process, so only what the database handed back can survive.
    const s2 = spy();
    const app2 = await buildServer({ pool, keys, router: s2.router, rateLimitMax: 100_000 });
    await app2.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload: { text: 'and what about now' } });
    await app2.close();

    expect(s2.sandboxSaw).toHaveLength(1);
    expect('image' in s2.sandboxSaw[0]!, 'turn two carried turn one\'s picture').toBe(false);
    expect(JSON.stringify(s2.sandboxSaw[0]!)).not.toContain(PIXELS);
    expect(s2.metered, 'a text-only turn was routed to the vision cell').toEqual(['sandbox']);
  }, 120_000);
});

// ---------------------------------------------------------------------------

describe('D4 — an upsetting picture locks the chat', () => {
  /** Drive one turn and report everything a parent and a child would see. */
  async function driveCrisis(payload: Record<string, unknown>) {
    const s = spy('CRISIS');
    const app = await buildServer({ pool, keys, router: s.router, rateLimitMax: 100_000 });
    const { cookies, sessionId, childId } = await open_(app);
    const r = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`, cookies,
      payload });
    const body = r.json() as {
      blocks: { kind: string; text?: string; emoji?: string; chips?: string[] }[];
      crisisLock: boolean; trace: string;
      flags: { kind: string; category: string; noteKey: string }[];
    };
    const locked = (await pool.query<{ crisis_lock: boolean }>(
      `SELECT crisis_lock FROM session WHERE id = $1`, [sessionId])).rows[0]!.crisis_lock;

    // What a second turn gets — the lock has to survive the response.
    const after = await app.inject({ method: 'POST', url: `/v1/session/${sessionId}/turn`,
      cookies, payload: { text: 'can we talk about something else' } });
    await app.close();
    return {
      body, locked, sessionId, childId,
      shown: body.blocks.map((b) => b.text ?? b.emoji ?? (b.chips ?? []).join(' ')).join(' '),
      afterLock: (after.json() as { crisisLock: boolean }).crisisLock,
      sandboxSaw: s.sandboxSaw,
    };
  }

  it('locks, shows the helplines, and flags a parent', async () => {
    const r = await driveCrisis({ text: 'what do you think of this?', image: picture });
    expect(r.body.crisisLock, 'a picture could not lock the chat').toBe(true);
    expect(r.locked, 'the lock was not persisted').toBe(true);
    expect(r.afterLock, 'the lock did not survive the next turn').toBe(true);
    expect(r.shown).toMatch(/1098|9152987821/);
    expect(r.body.flags.map((f) => f.kind)).toContain('SAFETY');
  }, 120_000);

  it('is the SAME script a crisis typed in words produces', async () => {
    const words = await driveCrisis({ text: 'i want to hurt myself' });
    const shown_ = await driveCrisis({ text: 'what do you think of this?', image: picture });
    expect(shown_.shown).toBe(words.shown);
    expect(shown_.body.flags.map((f) => ({ c: f.category, n: f.noteKey })))
      .toEqual(words.body.flags.map((f) => ({ c: f.category, n: f.noteKey })));
  }, 120_000);

  it('and the picture is STILL not stored on the turn that locked the chat', async () => {
    // The most dangerous turn to get this wrong on: a crisis flag is the one
    // record a human will go and read.
    const r = await driveCrisis({ text: 'what do you think of this?', image: picture });
    expect(await decryptedStores(r.sessionId, r.childId)).not.toContain(PIXELS);
    expect(await grepTextColumns([PIXELS])).toEqual([]);
  }, 120_000);

  it('a crisis phrase TYPED alongside a picture never sends the picture at all', async () => {
    // L1 fires on the text two layers above the sandbox, so no vendor ever sees
    // the image on this turn.
    const r = await driveCrisis({ text: 'i want to hurt myself', image: picture });
    expect(r.body.crisisLock).toBe(true);
    expect(r.sandboxSaw, 'L1 let the picture through to a vendor').toEqual([]);
  }, 120_000);
});
