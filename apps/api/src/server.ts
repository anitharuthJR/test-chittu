/**
 * The API. One endpoint runs the whole pipeline.
 *
 * Three things are true here and must stay true (chittu-architecture.md §1):
 *   1. Provider keys live in this process and nowhere else.
 *   2. Every guard runs here. A modified client cannot reach an unguarded model.
 *   3. Turns are BUFFERED, never streamed — L6 matches phrases, so it cannot
 *      judge "i will" before it has seen "miss you" (§4.2).
 *
 * State lives in Postgres. There is no in-memory alternative on purpose: two
 * implementations means the path the tests exercise is never quite the path
 * production runs. Tests use PGlite, which IS Postgres.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { runTurn } from '@chittu/pipeline';
import type { Band, Country, Mode } from '@chittu/contracts';
import { BANDS, COUNTRIES } from '@chittu/contracts';
import {
  assertActiveConsent, draftConsent, markVerifying, activate, revoke,
  selectAdapter, methodsFor, offersFor, ConsentError, ConsentAdapterError,
  checkPinPolicy, PIN_MESSAGE, hashPin, verifyPin, registerAttempt,
  type ConsentMethod,
} from '@chittu/consent';
import type { DbPool, KeyProvider } from '@chittu/db';
import { type ProviderRouter, stubRouter } from './providers.js';
import { createStore } from './store.js';
import {
  setConsentCookie, clearConsentCookie, readConsentCookie,
  setParentCookie, clearParentCookie, parentFor,
} from './cookies.js';

export interface BuildOptions {
  readonly pool: DbPool;
  readonly keys: KeyProvider;
  /** Injected so tests can count model calls and CI needs no provider key. */
  readonly router?: ProviderRouter;
  readonly logger?: boolean;
  /** Gates dev-only consent methods. Mirrors `deployment.env` in the schema. */
  readonly env?: 'dev' | 'staging' | 'prod';
  /**
   * Requests per minute. Raised by the test suite, which drives dozens of
   * families from one IP and would otherwise spend most of its assertions
   * discovering that the rate limiter works. It is exercised deliberately by a
   * test of its own instead.
   */
  readonly rateLimitMax?: number;
}

const MODES: readonly Mode[] = [
  'chat', 'learn', 'homework', 'story', 'create',
  'quiz', 'code', 'math', 'lang', 'draw', 'read',
];

/**
 * ASYNC, and that is load-bearing.
 *
 * `app.register()` defers plugin loading until `ready()`, so routes declared
 * synchronously after it are registered BEFORE the plugin's onRequest hook
 * exists — and the hook never reaches them. The result is a server that looks
 * rate-limited, reports no error, and is not: a flood of /health or
 * /pin/verify returned 200 every time.
 *
 * Awaiting the registration puts the hook in place first. The regression test
 * floods a route and asserts a 429, because "we registered the plugin" is not
 * evidence that anything is limited.
 */
export async function buildServer(opts: BuildOptions): Promise<FastifyInstance> {
  const env = opts.env ?? 'dev';
  const router = opts.router ?? stubRouter();
  const store = createStore(opts.pool, opts.keys);

  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional:true, which STRIPS an unexpected
        // field and returns 201 as though nothing happened. A client sending a
        // field we did not design for — a surname, a birthdate, a device id — is
        // a thing to find out about, not to quietly discard.
        removeAdditional: false,
        allErrors: false,
      },
    },
  });

  // Before the routes, for the same reason the rate limiter is: `register` only
  // takes effect at `ready()`, so anything declared before it never sees the
  // decorator. A route reading `req.cookies` without this gets `undefined` and
  // silently behaves as though nobody is signed in.
  await app.register(cookie);

  await app.register(rateLimit, {
    max: opts.rateLimitMax ?? 120,
    timeWindow: '1 minute',
    // Per session where the route has one, per IP otherwise. `req.params` is
    // populated by the time the plugin's onRequest hook runs, so a session's
    // turns share a bucket and one noisy client cannot exhaust another's.
    keyGenerator: (req) => {
      const id = (req.params as { id?: string } | undefined)?.id;
      return id ?? req.ip ?? 'anonymous';
    },
  });

  app.get('/health', async () => {
    const r = await opts.pool.query<{ n: number }>('SELECT 1::int AS n');
    return { status: r.rows[0]?.n === 1 ? 'ok' : 'degraded' };
  });

  // ---- consent ------------------------------------------------------------
  // Law 02: no code path may reach the chat before the consent ledger exists.

  app.get('/v1/consent/methods', async (req, reply) => {
    const country = (req.query as { country?: Country }).country;
    if (!country || !(COUNTRIES as readonly string[]).includes(country)) {
      return reply.code(400).send({ error: 'unknown country' });
    }
    return reply.send({
      country,
      methods: methodsFor(country, { env }),      // completable today
      offers: offersFor(country, { env }),        // everything valid, with blockedOn
    });
  });

  app.post<{
    Body: {
      parentName: string; parentEmail: string; childFirstName: string;
      country: Country; band: Band; board?: string;
      memoryOn?: boolean; learnOn?: boolean; method: ConsentMethod;
      pin: string; pinConfirm: string;
    };
  }>('/v1/consent/draft', {
    schema: {
      body: {
        type: 'object',
        required: ['parentName', 'parentEmail', 'childFirstName', 'country',
                   'band', 'method', 'pin', 'pinConfirm'],
        additionalProperties: false,
        properties: {
          parentName: { type: 'string', minLength: 1, maxLength: 80 },
          parentEmail: { type: 'string', format: 'email', maxLength: 200 },
          // first name only — there is nowhere in the schema to put a surname
          childFirstName: { type: 'string', minLength: 1, maxLength: 40 },
          country: { type: 'string', enum: [...COUNTRIES] },
          band: { type: 'string', enum: [...BANDS] },
          board: { type: 'string', maxLength: 60 },
          memoryOn: { type: 'boolean' },
          learnOn: { type: 'boolean' },
          method: { type: 'string', minLength: 1, maxLength: 40 },
          pin: { type: 'string', minLength: 4, maxLength: 6 },
          pinConfirm: { type: 'string', minLength: 4, maxLength: 6 },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const bad = checkPinPolicy(b.pin, b.pinConfirm);
    if (bad) return reply.code(400).send({ error: PIN_MESSAGE[bad], code: bad });

    let adapter;
    try { adapter = selectAdapter(b.method, { env }); }
    catch (e) { return reply.code(400).send({ error: (e as ConsentAdapterError).message }); }
    if (!adapter.jurisdictions.includes(b.country)) {
      return reply.code(400).send({ error: `${b.method} is not offered in ${b.country}` });
    }

    const draft = {
      parentName: b.parentName, parentEmail: b.parentEmail,
      childFirstName: b.childFirstName, country: b.country, band: b.band,
      board: b.board ?? 'General',
      // Requirements §4.1: memory defaults ON, learning is opt-IN, default OFF.
      memoryOn: b.memoryOn ?? true, learnOn: b.learnOn ?? false,
    };
    const record = markVerifying(draftConsent(draft, b.method));
    const challenge = await adapter.start(draft);
    await store.consent.createDraft(
      draft, b.method, record.law, await hashPin(b.pin), record);

    return reply.code(201).send({
      consentId: record.id,
      challengeId: challenge.challengeId,
      instructions: challenge.instructions,
      law: record.law,
      status: record.status,
    });
  });

  app.post<{ Params: { id: string }; Body: { challengeId: string; proof?: unknown } }>(
    '/v1/consent/:id/finalize', async (req, reply) => {
      const stored = await store.consent.byId(opts.pool, req.params.id);
      if (!stored) return reply.code(404).send({ error: 'no such consent' });
      const adapter = selectAdapter(stored.record.method, { env });
      try {
        const evidence = await adapter.complete(req.body.challengeId, req.body.proof);
        const active = activate(markVerifying2(stored.record), evidence);
        const { token } = await store.consent.activate(req.params.id, evidence, active);
        // The token goes into an httpOnly cookie and NOT into the body. It is a
        // bearer credential: anything that can read it can open a session as
        // this child, and a response body is readable by every script on the
        // page and by anything that logs responses.
        setConsentCookie(reply, token, { env });
        return reply.send({ ledger: active });
      } catch (e) {
        // A failed verification must NOT produce a consent. Say so plainly.
        return reply.code(422).send({
          error: e instanceof Error ? e.message : 'verification failed',
          status: stored.record.status,
        });
      }
    });

  /**
   * Who this request is, from the cookie alone.
   *
   * Nothing identifying a family travels in a URL or a body any more. The
   * previous shape took a consent id from the path, which meant the client had
   * to hold one — and a consent id was enough to erase an account.
   */
  async function consentFromCookie(req: FastifyRequest) {
    const token = readConsentCookie(req);
    if (token === null) return null;
    return store.consent.findByToken(opts.pool, token);
  }

  /**
   * Does the browser hold an active consent? The client cannot read an httpOnly
   * cookie, so it cannot answer this itself — and that is the point: the SERVER
   * decides whether the chat is reachable, and the client asks.
   *
   * Returns no consent id and no token. The band and country are already
   * governed by the sealed record; they are here so the client can size its
   * touch targets without a second round trip.
   */
  app.get('/v1/consent/status', async (req, reply) => {
    const presented = readConsentCookie(req) !== null;
    // Any cookie that does NOT resolve to an active consent gets cleared —
    // including the revoked case, where `findByToken` returns nothing at all
    // because revocation nulls `token_hash`. The first version of this only
    // cleared when the record resolved but failed `assertActiveConsent`, which
    // meant the one path that matters most left the browser presenting a dead
    // credential on every request for ninety days.
    const dead = (): void => { if (presented) clearConsentCookie(reply, { env }); };

    const stored = await consentFromCookie(req);
    if (!stored) { dead(); return reply.send({ active: false }); }
    try {
      const active = assertActiveConsent(stored.record);
      return reply.send({
        active: true,
        band: active.record.band,
        country: active.record.country,
        childFirstName: active.record.childFirstName,
      });
    } catch {
      dead();
      return reply.send({ active: false });
    }
  });

  /**
   * Revocation, and the hole this closes.
   *
   * This used to be `DELETE /v1/consent/:id` with NO authentication at all: a
   * consent id was sufficient to erase a child's entire record, and the client
   * was keeping one in `localStorage` where the child could read it. It now
   * requires the consent cookie AND a live parent session, so erasure is a
   * thing only someone who has entered the PIN in the last fifteen minutes can
   * do.
   */
  app.delete('/v1/consent', async (req, reply) => {
    const stored = await consentFromCookie(req);
    if (!stored) return reply.code(401).send({ error: 'not signed in' });
    const parentOf = parentFor(req, await opts.keys.indexKey());
    if (parentOf !== stored.consentId) {
      return reply.code(403).send({
        error: 'a parent PIN is required to erase an account',
        code: 'PARENT_REQUIRED',
      });
    }
    // Count what revocation actually ended, so the parent is told a number
    // rather than a reassurance. revoke_and_erase closes them; this reads back.
    const live = await opts.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM session
        WHERE child_id = $1 AND ended_at IS NULL`, [stored.childId]);
    await store.consent.revokeAndErase(stored.consentId, stored.childId, 'parent request');
    const after = await store.consent.byId(opts.pool, stored.consentId);
    clearConsentCookie(reply, { env });
    clearParentCookie(reply, { env });
    return reply.send({
      status: 'revoked',
      sessionsEnded: live.rows[0]?.n ?? 0,
      ledger: after ? after.record : revoke(stored.record, 'parent request'),
    });
  });

  app.post<{ Body: { pin: string } }>(
    '/v1/parent/pin/verify', {
      schema: {
        body: {
          type: 'object', required: ['pin'], additionalProperties: false,
          properties: { pin: { type: 'string', minLength: 4, maxLength: 6 } },
        },
      },
    }, async (req, reply) => {
      const stored = await consentFromCookie(req);
      // Same shape whether the cookie resolves or not — distinguishing "no
      // consent" from "wrong PIN" would tell an attacker which is which.
      if (!stored) return reply.code(401).send({ ok: false, locked: false });
      const pin = await store.consent.pinFor(opts.pool, stored.parentId);
      if (!pin) return reply.code(401).send({ ok: false, locked: false });

      const correct = await verifyPin(req.body.pin, pin.hash);
      const r = registerAttempt(
        { failedAttempts: pin.failedAttempts, lockedUntil: pin.lockedUntil },
        correct, Date.now());
      await store.consent.savePinState(
        stored.parentId, r.state.failedAttempts, r.state.lockedUntil);
      if (r.justLocked) {
        app.log.warn({ consentId: stored.consentId }, 'parent PIN locked out');
        await store.withChild(stored.childId, (tx) =>
          store.child.addFlag(tx, stored.childId, null as never, 'GATE', 'PIN_LOCKOUT'));
      }
      // The parent session is minted ONLY on a correct PIN, and only here.
      if (r.ok) setParentCookie(reply, stored.consentId, await opts.keys.indexKey(), { env });
      return reply.code(r.ok ? 200 : 401).send({
        ok: r.ok,
        locked: r.locked,
        ...(r.justLocked
          ? { note: "Five wrong attempts — locked for 60 seconds. If this wasn't you, it may have been a curious child." }
          : {}),
      });
    });

  /** Ends the parent session without touching the child's. */
  app.post('/v1/parent/signout', async (_req, reply) => {
    clearParentCookie(reply, { env });
    return reply.send({ ok: true });
  });

  // ---- sessions -----------------------------------------------------------

  app.post<{ Body?: { mode?: Mode } }>('/v1/session', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: [...MODES] },
        },
      },
    },
  }, async (req, reply) => {
    // THE GATE. Band, board and country come from the sealed record, never from
    // the request, so a client cannot assert a band it was not granted. Three
    // layers must agree: the token only resolves on an ACTIVE consent
    // (token_only_when_active), assertActiveConsent re-checks the status and the
    // seal, and the record supplies every field the session uses.
    //
    // The token now arrives in an httpOnly cookie rather than the body, which
    // adds a fourth thing the client cannot do: read the credential it is
    // presenting. There is deliberately no body fallback — two ways in would
    // mean the safe one is optional.
    const stored = await consentFromCookie(req);
    let active;
    try {
      active = assertActiveConsent(stored?.record);
    } catch (e) {
      const err = e as ConsentError;
      return reply.code(403).send({ error: err.message, code: err.code });
    }
    const c = active.record;
    const sessionId = await store.openSession(stored!.childId, stored!.consentId, c.band);
    return reply.code(201).send({ sessionId, band: c.band, country: c.country });
  });

  // ---- the pipeline. Buffered, never streamed. ----------------------------

  app.post<{ Params: { id: string }; Body: { text: string; mode?: Mode } }>(
    '/v1/session/:id/turn', {
      schema: {
        params: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object', required: ['text'], additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 2000 },
            mode: { type: 'string', enum: [...MODES] },
          },
        },
      },
    }, async (req, reply) => {
      // Which child this session belongs to must be known BEFORE the scope is
      // set, so this one lookup is unscoped and reads nothing but the mapping.
      const owner = await opts.pool.query<{ child_id: string; ended_at: string | null }>(
        `SELECT child_id, ended_at FROM session WHERE id = $1`, [req.params.id]);
      const row = owner.rows[0];
      if (!row) return reply.code(404).send({ error: 'no such session' });
      if (row.ended_at) return reply.code(409).send({ error: 'session ended' });

      const result = await store.withChild(row.child_id, async (tx) => {
        const loaded = await store.loadSession(tx, req.params.id);
        if (!loaded) return null;
        const state = req.body.mode
          ? { ...loaded.state, mode: req.body.mode }
          : loaded.state;

        // The whole turn — seal, guards, model calls, writes — commits together
        // or not at all. A turn that fails halfway must not leave a session
        // half-guarded or a chain with a gap.
        const out = await runTurn(state, req.body.text, {
          classify: (text, history) => router.classify(text, history),
          generate: (input) => router.generate(input),
          seal: store.sealFor(tx, req.params.id),
          now: () => new Date().toISOString(),
          newId: () => randomUUID(),
        });

        const replyText = out.response.blocks
          .map((b) => (b.kind === 'chips' ? b.chips.join(' ')
            : b.kind === 'steps' ? b.items.join(' ')
            : b.kind === 'big' ? b.emoji : b.text)).join(' ');

        await store.saveTurn(
          tx, req.params.id, loaded.childId, state.band, out.state,
          state.mode, req.body.text, replyText, out.response.trace,
          out.response.layers,
          out.response.flags.map((f) => f.assistTopic !== undefined
            ? { kind: f.kind, noteKey: f.noteKey, assistTopic: f.assistTopic }
            : { kind: f.kind, noteKey: f.noteKey }),
          out.response.memorySaved);

        return out.response;
      });

      if (!result) return reply.code(404).send({ error: 'no such session' });
      // The child never receives raw model text — only parsed blocks, the trace,
      // and the layers that ran.
      return reply.send(result);
    });

  // ---- the memory book ----------------------------------------------------
  /**
   * Scoped by SESSION, not by child id. The session id is the capability the
   * caller already holds; taking a child id from the request would let a client
   * name a child it has no session for, and the row-level security scope would
   * then be set from an attacker-supplied value.
   *
   * Child and parent both read the SAME list and both can delete from it
   * (requirements §4.3) — `deleted_by` records which. A memory book that showed
   * a child one thing and an adult another would make the child's copy a
   * decoration, and the point of showing it is that a child can act on it.
   */
  async function childForSession(sessionId: string): Promise<string | null> {
    const r = await opts.pool.query<{ child_id: string }>(
      `SELECT child_id FROM session WHERE id = $1`, [sessionId]);
    return r.rows[0]?.child_id ?? null;
  }

  app.get<{ Params: { id: string } }>(
    '/v1/session/:id/memories', {
      schema: {
        params: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    }, async (req, reply) => {
      const childId = await childForSession(req.params.id);
      if (childId === null) return reply.code(404).send({ error: 'no such session' });
      const memories = await store.withChild(childId, (tx) =>
        store.child.listMemories(tx, childId));
      return reply.send({ memories });
    });

  app.delete<{ Params: { id: string; memoryId: string }; Querystring: { by?: string } }>(
    '/v1/session/:id/memories/:memoryId', {
      schema: {
        params: {
          type: 'object', required: ['id', 'memoryId'], additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' },
            memoryId: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { by: { type: 'string', enum: ['child', 'parent'] } },
        },
      },
    }, async (req, reply) => {
      const childId = await childForSession(req.params.id);
      if (childId === null) return reply.code(404).send({ error: 'no such session' });
      // `deleted_by` is audit data, so it is DERIVED from whether a live parent
      // session is presented — never taken from the query string. The `by`
      // parameter used to be believed, which meant the record of who deleted a
      // memory was whatever the caller typed.
      const by = parentFor(req, await opts.keys.indexKey()) !== null ? 'parent' : 'child';
      const forgotten = await store.withChild(childId, async (tx) => {
        const ok = await store.child.forgetMemory(tx, childId, req.params.memoryId, by);
        if (ok) {
          // Sealed, because "you can delete it" is a claim a parent should be
          // able to check rather than take on trust. The fact of the deletion is
          // recorded; the fact deleted is not.
          await store.audit.append(tx, {
            sessionId: req.params.id, role: 'system', layer: 'LEDGER',
            text: `memory forgotten by ${by}`,
          });
        }
        return ok;
      });
      return reply.code(forgotten ? 200 : 404).send({ forgotten });
    });

  app.get<{ Params: { id: string } }>('/v1/session/:id/seal', async (req, reply) => {
    const v = await store.audit.verify(req.params.id);
    if (v.records === 0) {
      const exists = await opts.pool.query(`SELECT 1 FROM session WHERE id = $1`,
        [req.params.id]);
      if (exists.rows.length === 0) return reply.code(404).send({ error: 'no such session' });
    }
    return reply.send({ ok: v.ok, records: v.records, brokenAt: v.brokenAt });
  });

  /**
   * The only unlock path in the system (§4.5), and it is now BOUND to the PIN.
   *
   * The previous version of this comment said the binding "is not wired yet, so
   * the route is registered only outside production" — a child who found the
   * URL could lift their own crisis lock in dev. It requires a live parent
   * session, which exists only after a correct PIN, so it is safe to register
   * everywhere and the env guard is gone.
   */
  app.post<{ Params: { id: string } }>('/v1/session/:id/crisis/ack', async (req, reply) => {
    const owner = await opts.pool.query<{ child_id: string; consent_id: string }>(
      `SELECT child_id, consent_id FROM session WHERE id = $1`, [req.params.id]);
    const row = owner.rows[0];
    if (!row) return reply.code(404).send({ error: 'no such session' });

    // The parent session must be for THIS consent. A parent of one family
    // holding a valid cookie must not be able to unlock another family's child.
    if (parentFor(req, await opts.keys.indexKey()) !== row.consent_id) {
      return reply.code(403).send({
        error: 'a parent PIN is required to unlock',
        code: 'PARENT_REQUIRED',
      });
    }
    const stored = await store.consent.byId(opts.pool, row.consent_id);
    await store.withChild(row.child_id, async (tx) => {
      await store.child.acknowledgeCrisis(tx, req.params.id, stored!.parentId);
      await store.audit.append(tx, {
        sessionId: req.params.id, role: 'system', layer: 'LEDGER',
        text: 'crisis acknowledged by parent',
      });
    });
    return reply.send({ crisisLock: false });
  });

  // Never leak an internal error to a child's screen. 4xx are our own validation
  // messages; 5xx are replaced, because a stack trace or a provider's error text
  // must not become something a child reads.
  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send(
      status < 500 ? { error: e.message ?? 'bad request' } : { error: 'something went wrong' },
    );
  });

  return app;
}

/**
 * A record read back from the database is already `verifying`; `activate` insists
 * on that status, and re-sealing it here would change the hash. This exists to
 * make the round-trip explicit rather than hiding it behind a cast.
 */
function markVerifying2(r: Parameters<typeof activate>[0]): Parameters<typeof activate>[0] {
  return r.status === 'verifying' ? r : markVerifying(r);
}
