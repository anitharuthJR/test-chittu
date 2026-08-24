/**
 * The API. One endpoint runs the whole pipeline.
 *
 * The point of this service is stated in chittu-architecture.md §1: move the
 * safety kernel behind an API and make the client too thin to matter. So three
 * things are true here and must stay true:
 *
 *   1. Provider keys live in this process and nowhere else.
 *   2. Every guard runs here. A modified client cannot reach an unguarded model.
 *   3. Turns are BUFFERED, never streamed. L6 matches phrases, so it cannot
 *      judge "i will" before it has seen "miss you" — streaming raw tokens ships
 *      text that has not passed the wall. See chittu-architecture.md §4.2.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { createChain } from '@chittu/seal';
import { runTurn, type PipelinePorts, type SessionState } from '@chittu/pipeline';
import type { Band, Country, Mode } from '@chittu/contracts';
import { BANDS, COUNTRIES } from '@chittu/contracts';
import { type ProviderRouter, stubRouter } from './providers.js';
import {
  assertActiveConsent, draftConsent, markVerifying, activate, revoke,
  selectAdapter, methodsFor, offersFor, ConsentError, ConsentAdapterError,
  checkPinPolicy, PIN_MESSAGE, hashPin, verifyPin,
  registerAttempt, FRESH_LOCKOUT,
  type ConsentRecord, type ConsentMethod, type LockoutState,
} from '@chittu/consent';

export interface Session {
  readonly id: string;
  readonly consentId: string;
  state: SessionState;
  readonly ports: PipelinePorts;
  readonly startedAt: string;
  ended: boolean;
}

export interface BuildOptions {
  /** Injected so tests can count model calls and CI needs no provider key. */
  readonly router?: ProviderRouter;
  readonly logger?: boolean;
  /** Gates dev-only consent methods. Mirrors `deployment.env` in the schema. */
  readonly env?: 'dev' | 'staging' | 'prod';
}

interface ConsentEntry {
  record: ConsentRecord;
  /** Bearer token, separate from the record id: an identifier is not a credential. */
  token: string | null;
  pinHash: string | null;
  lockout: LockoutState;
}

const MODES: readonly Mode[] = [
  'chat', 'learn', 'homework', 'story', 'create',
  'quiz', 'code', 'math', 'lang', 'draw', 'read',
];

export function buildServer(opts: BuildOptions = {}): FastifyInstance {
  const env = opts.env ?? 'dev';
  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional:true, which STRIPS an unexpected
        // field and returns 201 as though nothing happened. We want the 400.
        // A client sending a field we did not design for — `surname`, a
        // birthdate, a device id — is a thing to find out about, not to quietly
        // discard: silent acceptance is how a field nobody agreed to collect
        // ends up being sent for months before anyone notices.
        removeAdditional: false,
        allErrors: false,
      },
    },
  });
  const router = opts.router ?? stubRouter();

  /**
   * In-memory sessions. Deliberate for this increment, and a known gap: the
   * schema and migrations exist (db/), but nothing is wired to Postgres yet, so
   * a restart forgets every session and the seal chain with it. Consent is not
   * enforced here either — `POST /v1/session` accepts a band and a country
   * rather than a consent token. Law 02 says no code path may reach the chat
   * before the consent ledger exists, so this service MUST NOT be deployed
   * anywhere a child can reach it until the consent engine lands.
   */
  const sessions = new Map<string, Session>();
  const consents = new Map<string, ConsentEntry>();

  app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    // Per session where we have one, per IP otherwise. A child's turn rate is
    // low; this is here to make an unattended client cheap to survive.
    keyGenerator: (req) => (req.params as { id?: string })?.id ?? req.ip,
  });

  app.get('/health', async () => ({ status: 'ok', sessions: sessions.size }));

  // -------------------------------------------------------------------------

  // ---- consent ------------------------------------------------------------
  // Law 02: no code path may reach the chat before the consent ledger exists.
  // Every route below exists so that the session route can refuse.

  app.get('/v1/consent/methods', async (req, reply) => {
    const country = (req.query as { country?: Country }).country;
    if (!country || !(COUNTRIES as readonly string[]).includes(country)) {
      return reply.code(400).send({ error: 'unknown country' });
    }
    // `methods` is what a parent can complete; `offers` shows ops what is blocked
    return reply.send({
      country,
      methods: methodsFor(country, { env }),
      offers: offersFor(country, { env }),
    });
  });

  app.post<{
    Body: {
      parentName: string; childFirstName: string; country: Country; band: Band;
      board?: string; memoryOn?: boolean; learnOn?: boolean; method: ConsentMethod;
      pin: string; pinConfirm: string;
    };
  }>('/v1/consent/draft', {
    schema: {
      body: {
        type: 'object',
        required: ['parentName', 'childFirstName', 'country', 'band', 'method', 'pin', 'pinConfirm'],
        additionalProperties: false,
        properties: {
          parentName: { type: 'string', minLength: 1, maxLength: 80 },
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
    catch (e) {
      return reply.code(400).send({ error: (e as ConsentAdapterError).message });
    }
    if (!adapter.jurisdictions.includes(b.country)) {
      return reply.code(400).send({ error: `${b.method} is not offered in ${b.country}` });
    }

    const draft = {
      parentName: b.parentName, childFirstName: b.childFirstName,
      country: b.country, band: b.band, board: b.board ?? 'General',
      // Requirements §4.1: memory defaults ON, learning is opt-IN, default OFF.
      memoryOn: b.memoryOn ?? true, learnOn: b.learnOn ?? false,
    };
    const record = markVerifying(draftConsent(draft, b.method));
    const challenge = await adapter.start(draft);
    consents.set(record.id, {
      record, token: null, pinHash: await hashPin(b.pin), lockout: FRESH_LOCKOUT,
    });
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
      const entry = consents.get(req.params.id);
      if (!entry) return reply.code(404).send({ error: 'no such consent' });
      const adapter = selectAdapter(entry.record.method, { env });
      try {
        const evidence = await adapter.complete(req.body.challengeId, req.body.proof);
        entry.record = activate(entry.record, evidence);
        entry.token = randomUUID();
      } catch (e) {
        // A failed verification must NOT produce a consent. Say so plainly.
        return reply.code(422).send({
          error: e instanceof Error ? e.message : 'verification failed',
          status: entry.record.status,
        });
      }
      return reply.send({
        consentToken: entry.token,
        ledger: entry.record,          // sealed; the parent can verify it
      });
    });

  app.delete<{ Params: { id: string } }>('/v1/consent/:id', async (req, reply) => {
    const entry = consents.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'no such consent' });
    entry.record = revoke(entry.record, 'parent request');
    entry.token = null;
    // Revocation propagates: every session on this consent ends immediately.
    let killed = 0;
    for (const [sid, s] of sessions) {
      if (s.consentId === req.params.id) { s.ended = true; sessions.delete(sid); killed += 1; }
    }
    return reply.send({ status: 'revoked', sessionsEnded: killed, ledger: entry.record });
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
      const entry = consents.get(req.params.id);
      // Same shape whether the consent exists or not — a 404 here would tell an
      // attacker which consent ids are real.
      if (!entry?.pinHash) return reply.code(401).send({ ok: false });
      const correct = await verifyPin(req.body.pin, entry.pinHash);
      const r = registerAttempt(entry.lockout, correct, Date.now());
      entry.lockout = r.state;
      if (r.justLocked) {
        app.log.warn({ consentId: req.params.id }, 'parent PIN locked out');
      }
      return reply.code(r.ok ? 200 : 401).send({
        ok: r.ok,
        locked: r.locked,
        ...(r.justLocked ? { note: 'Five wrong attempts — locked for 60 seconds. If this wasn\'t you, it may have been a curious child.' } : {}),
      });
    });

  // ---- sessions -----------------------------------------------------------

  app.post<{ Body: { consentToken: string; mode?: Mode } }>('/v1/session', {
    schema: {
      body: {
        type: 'object',
        required: ['consentToken'],
        additionalProperties: false,
        properties: {
          consentToken: { type: 'string', format: 'uuid' },
          mode: { type: 'string', enum: [...MODES] },
        },
      },
    },
  }, async (req, reply) => {
    // THE GATE. Band, board and country come from the sealed record, never from
    // the request — so a client cannot assert a band it was not granted, and a
    // tampered ledger row fails the seal check rather than opening a session.
    //
    // Two independent refusals guard a revoked consent: the token is nulled on
    // revocation (so the lookup misses), AND assertActiveConsent rejects the
    // status. Either alone is sufficient. That redundancy means an API-level
    // test cannot tell which one fired, so the status path is covered directly
    // by the unit tests in @chittu/consent rather than only from out here.
    const entry = [...consents.values()]
      .find((c) => c.token !== null && c.token === req.body.consentToken);
    let active;
    try {
      active = assertActiveConsent(entry?.record);
    } catch (e) {
      const err = e as ConsentError;
      return reply.code(403).send({ error: err.message, code: err.code });
    }
    const c = active.record;

    const id = randomUUID();
    const ports: PipelinePorts = {
      classify: (text, history) => router.classify(text, history),
      generate: (input) => router.generate(input),
      seal: createChain(),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    };
    sessions.set(id, {
      id,
      consentId: c.id,
      startedAt: new Date().toISOString(),
      ended: false,
      ports,
      state: {
        kid: c.childFirstName, band: c.band, country: c.country,
        board: c.board, mode: req.body.mode ?? 'chat',
        crisisLock: false,
        // memory is a SCOPE, not a preference the client sends
        memOn: active.scopes.includes('memory'),
        memories: [], mathPractice: null,
        history: [], spineCount: 0, flags: [], topics: [], assists: [],
        lastSubject: null,
      },
    });
    return reply.code(201).send({ sessionId: id, band: c.band, country: c.country });
  });

  // -------------------------------------------------------------------------
  // The pipeline. Buffered, never streamed.

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
      const session = sessions.get(req.params.id);
      if (!session) return reply.code(404).send({ error: 'no such session' });
      if (session.ended) return reply.code(409).send({ error: 'session ended' });

      if (req.body.mode) session.state = { ...session.state, mode: req.body.mode };

      const { state, response } = await runTurn(session.state, req.body.text, session.ports);
      session.state = state;

      // The child never receives raw model text — only parsed blocks, the trace,
      // and the layers that ran. There is no field here through which markup
      // could reach a renderer.
      return reply.send(response);
    });

  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/v1/session/:id/seal', async (req, reply) => {
    const session = sessions.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    const v = session.ports.seal.verify();
    return reply.send({ ok: v.ok, records: session.ports.seal.size() });
  });

  /**
   * The only unlock path in the system (requirements §4.5). It is a parent
   * action and MUST be behind PIN verification before this ships — that is not
   * wired yet, so the route is registered only outside production.
   */
  if (process.env['NODE_ENV'] !== 'production') {
    app.post<{ Params: { id: string } }>('/v1/session/:id/crisis/ack', async (req, reply) => {
      const session = sessions.get(req.params.id);
      if (!session) return reply.code(404).send({ error: 'no such session' });
      session.state = { ...session.state, crisisLock: false };
      await session.ports.seal.append({
        role: 'parent', layer: 'LEDGER', text: 'crisis acknowledged by parent',
      });
      return reply.send({ crisisLock: false });
    });
  }

  // Never leak an internal error to a child's screen. 4xx are our own validation
  // messages and safe to return; 5xx are replaced, because a stack trace or a
  // provider's error text must not become something a child reads.
  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send(
      status < 500
        ? { error: e.message ?? 'bad request' }
        : { error: 'something went wrong' },
    );
  });

  return app;
}
