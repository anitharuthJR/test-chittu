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

export interface Session {
  readonly id: string;
  state: SessionState;
  readonly ports: PipelinePorts;
  readonly startedAt: string;
  ended: boolean;
}

export interface BuildOptions {
  /** Injected so tests can count model calls and CI needs no provider key. */
  readonly router?: ProviderRouter;
  readonly logger?: boolean;
}

const MODES: readonly Mode[] = [
  'chat', 'learn', 'homework', 'story', 'create',
  'quiz', 'code', 'math', 'lang', 'draw', 'read',
];

export function buildServer(opts: BuildOptions = {}): FastifyInstance {
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

  app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    // Per session where we have one, per IP otherwise. A child's turn rate is
    // low; this is here to make an unattended client cheap to survive.
    keyGenerator: (req) => (req.params as { id?: string })?.id ?? req.ip,
  });

  app.get('/health', async () => ({ status: 'ok', sessions: sessions.size }));

  // -------------------------------------------------------------------------

  app.post<{
    Body: { kid: string; band: Band; country: Country; board?: string; mode?: Mode };
  }>('/v1/session', {
    schema: {
      body: {
        type: 'object',
        required: ['kid', 'band', 'country'],
        additionalProperties: false,
        properties: {
          // first name only — the schema does not have anywhere to put a surname
          kid: { type: 'string', minLength: 1, maxLength: 40 },
          band: { type: 'string', enum: [...BANDS] },
          country: { type: 'string', enum: [...COUNTRIES] },
          board: { type: 'string', maxLength: 60 },
          mode: { type: 'string', enum: [...MODES] },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
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
      startedAt: new Date().toISOString(),
      ended: false,
      ports,
      state: {
        kid: b.kid, band: b.band, country: b.country,
        board: b.board ?? 'General', mode: b.mode ?? 'chat',
        crisisLock: false, memOn: true, memories: [], mathPractice: null,
        history: [], spineCount: 0, flags: [], topics: [], assists: [],
        lastSubject: null,
      },
    });
    return reply.code(201).send({ sessionId: id });
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
