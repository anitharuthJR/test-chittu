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

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
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
        return reply.send({ consentToken: token, ledger: active });
      } catch (e) {
        // A failed verification must NOT produce a consent. Say so plainly.
        return reply.code(422).send({
          error: e instanceof Error ? e.message : 'verification failed',
          status: stored.record.status,
        });
      }
    });

  app.delete<{ Params: { id: string } }>('/v1/consent/:id', async (req, reply) => {
    const stored = await store.consent.byId(opts.pool, req.params.id);
    if (!stored) return reply.code(404).send({ error: 'no such consent' });
    // Count what revocation actually ended, so the parent is told a number
    // rather than a reassurance. revoke_and_erase closes them; this reads back.
    const live = await opts.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM session
        WHERE child_id = $1 AND ended_at IS NULL`, [stored.childId]);
    await store.consent.revokeAndErase(stored.consentId, stored.childId, 'parent request');
    const after = await store.consent.byId(opts.pool, req.params.id);
    return reply.send({
      status: 'revoked',
      sessionsEnded: live.rows[0]?.n ?? 0,
      ledger: after ? after.record : revoke(stored.record, 'parent request'),
    });
  });

  app.post<{ Params: { id: string }; Body: { pin: string } }>(
    '/v1/consent/:id/pin/verify', {
      schema: {
        body: {
          type: 'object', required: ['pin'], additionalProperties: false,
          properties: { pin: { type: 'string', minLength: 4, maxLength: 6 } },
        },
      },
    }, async (req, reply) => {
      const stored = await store.consent.byId(opts.pool, req.params.id);
      // Same shape whether the consent exists or not — a 404 here would tell an
      // attacker which consent ids are real.
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
        app.log.warn({ consentId: req.params.id }, 'parent PIN locked out');
        await store.withChild(stored.childId, (tx) =>
          store.child.addFlag(tx, stored.childId, null as never, 'GATE', 'PIN_LOCKOUT'));
      }
      return reply.code(r.ok ? 200 : 401).send({
        ok: r.ok,
        locked: r.locked,
        ...(r.justLocked
          ? { note: "Five wrong attempts — locked for 60 seconds. If this wasn't you, it may have been a curious child." }
          : {}),
      });
    });

  // ---- sessions -----------------------------------------------------------

  app.post<{ Body: { consentToken: string; mode?: Mode } }>('/v1/session', {
    schema: {
      body: {
        type: 'object', required: ['consentToken'], additionalProperties: false,
        properties: {
          consentToken: { type: 'string', minLength: 20, maxLength: 100 },
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
    const stored = await store.consent.findByToken(opts.pool, req.body.consentToken);
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
   * The only unlock path in the system (§4.5). It is a parent action and MUST be
   * behind PIN verification before this ships — that binding is not wired yet, so
   * the route is registered only outside production.
   */
  if (env !== 'prod') {
    app.post<{ Params: { id: string } }>('/v1/session/:id/crisis/ack', async (req, reply) => {
      const owner = await opts.pool.query<{ child_id: string; consent_id: string }>(
        `SELECT child_id, consent_id FROM session WHERE id = $1`, [req.params.id]);
      const row = owner.rows[0];
      if (!row) return reply.code(404).send({ error: 'no such session' });
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
  }

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
