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
 * production runs. Tests use a real Postgres 16 + pgvector server.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { runTurn } from '@chittu/pipeline';
import type { Band, Block, Country, Mode, ModelUsage, TurnSignal } from '@chittu/contracts';
import { BANDS, COUNTRIES } from '@chittu/contracts';
import {
  assertActiveConsent, draftConsent, markVerifying, activate, revoke,
  selectAdapter, methodsFor, offersFor, ConsentError, ConsentAdapterError,
  checkPinPolicy, PIN_MESSAGE, hashPin, verifyPin, registerAttempt,
  type ConsentMethod, type DiditConfig,
} from '@chittu/consent';
import type { DbPool, KeyProvider } from '@chittu/db';
import { meteringRepo, sessionPseudonym, signalRepo } from '@chittu/db';
import { costFor, rateFor } from './providers/rates.js';
import { type ProviderRouter, stubRouter } from './providers.js';
import { parseOperators } from './ops/auth.js';
import { opsRoutes } from './ops/routes.js';
import { createStore } from './store.js';
import {
  CRISIS_WELCOME_BACK, REGISTRY, abstractShape, welcomeMemory, welcomeSpine,
} from '@chittu/safety-kernel';
import { passageById } from '@chittu/reading-coach';
import { resolveHelplines } from './helplines/resolve.js';
import { embedderFor, type Embedder } from './corpus/embed.js';
import { groundingPort } from './corpus/ground.js';
import { runMathsHarness } from './maths-harness.js';
import { buildCertification } from './certification.js';
import {
  setConsentCookie, clearConsentCookie, readConsentCookie,
  setParentCookie, clearParentCookie, parentFor,
  setIdCheckCookie, clearIdCheckCookie, pendingIdCheck,
} from './cookies.js';

export interface BuildOptions {
  readonly pool: DbPool;
  readonly keys: KeyProvider;
  /** Injected so tests can count model calls and CI needs no provider key. */
  readonly router?: ProviderRouter;
  /**
   * `true` for pino defaults, `false` for silence, or a pino options object.
   * Typed as `object` rather than `Record<string, unknown>` so a precise
   * interface (logging.ts's `LoggerOptions`) is assignable without an index
   * signature it has no reason to carry.
   */
  readonly logger?: boolean | object;
  /** Gates dev-only consent methods. Mirrors `deployment.env` in the schema. */
  readonly env?: 'dev' | 'staging' | 'prod';
  /**
   * `name=token,...`. When absent or empty the ops console is NOT REGISTERED —
   * its routes 404 rather than 403. A console that exists everywhere and is
   * merely protected is a larger surface than one that is not there.
   */
  readonly opsTokens?: string;
  /**
   * Requests per minute. Raised by the test suite, which drives dozens of
   * families from one IP and would otherwise spend most of its assertions
   * discovering that the rate limiter works. It is exercised deliberately by a
   * test of its own instead.
   */
  readonly rateLimitMax?: number;
  /**
   * Overrides the corpus embedder, which is otherwise DERIVED FROM THE ROUTER
   * (`embedderFor`) so that clearance and metering apply to it.
   *
   * Present only so a test can drive retrieval without a local endpoint on the
   * box. A deployment should leave it unset and let the routing decide: the
   * `embedding` cell names the provider, `provider_clearance` clears it, and a
   * provider without an embeddings API is refused by capability rather than by
   * configuration.
   */
  readonly embed?: Embedder;
  /**
   * Credentials for the automated ID rail (`automated_id_check`).
   *
   * ABSENT MEANS THE METHOD IS NOT OFFERED. It is filtered out of
   * `/v1/consent/methods` rather than advertised and then failing when a parent
   * picks it — the same reason `available` exists on the adapter at all.
   */
  readonly didit?: DiditConfig;
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
  /**
   * Registry options for the adapter selection calls.
   *
   * `attemptsUsed` is threaded in per-request at `finalize` because it is
   * per-consent state; everything else is process-wide config.
   */
  const registry = (attemptsUsed?: number) => ({
    env,
    ...(opts.didit ? { didit: opts.didit } : {}),
    ...(attemptsUsed !== undefined ? { attemptsUsed } : {}),
  });
  const router = opts.router ?? stubRouter();
  const store = createStore(opts.pool, opts.keys);
  /**
   * The corpus embedder comes from the ROUTER, so an embedding call — which
   * carries a child's turn to a provider — is routed, cleared and metered like
   * every other. Null when the router cannot embed at all (the stub, or a
   * deployment with no embedding-capable provider), and null is what turns the
   * corpus off: `runTurn` then stamps no CORPUS layer rather than one that ran
   * nothing.
   */
  const embed = opts.embed ?? embedderFor(router);
  const groundFor = embed ? groundingPort(opts.pool, embed) : null;

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

  /**
   * The ops console, registered only when operators are configured — see
   * BuildOptions.opsTokens and ops/routes.ts. `parseOperators` throws on a
   * malformed or weak entry, so a deployment with a broken CHITTU_OPS_TOKENS
   * fails to build rather than starting with a console nobody can reach or, far
   * worse, one anybody can.
   */
  const operators = parseOperators(
    opts.opsTokens === undefined ? {} : { CHITTU_OPS_TOKENS: opts.opsTokens });
  if (operators.size > 0) {
    await app.register(opsRoutes({
      pool: opts.pool, keys: opts.keys, operators, secure: env !== 'dev',
    }));
  }

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
      methods: methodsFor(country, registry()),   // completable today
      offers: offersFor(country, registry()),     // everything valid, with blockedOn
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
    try { adapter = selectAdapter(b.method, registry()); }
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

    // A rail that hands off to a vendor loses every scrap of client state at the
    // redirect, so the server remembers which verification this browser is
    // part-way through. Signed, httpOnly, and not a credential — see cookies.ts.
    if (challenge.redirectUrl) {
      setIdCheckCookie(
        reply,
        { consentId: record.id, challengeId: challenge.challengeId },
        await opts.keys.indexKey(),
        { env },
      );
    }

    return reply.code(201).send({
      consentId: record.id,
      challengeId: challenge.challengeId,
      instructions: challenge.instructions,
      // Only rails that hand off to a vendor-hosted page set this. The client
      // renders the hand-off when it is present and never assumes one exists.
      ...(challenge.redirectUrl ? { redirectUrl: challenge.redirectUrl } : {}),
      law: record.law,
      status: record.status,
    });
  });

  /**
   * Complete a verification. Shared by both entry points below, because they
   * differ only in how they learn WHICH verification — everything after that,
   * including every refusal, must be identical or the two paths drift.
   */
  async function completeVerification(
    consentId: string, challengeId: string, proof: unknown,
    reply: FastifyReply,
  ) {
    const stored = await store.consent.byId(opts.pool, consentId);
    if (!stored) return reply.code(404).send({ error: 'no such consent' });
    // Attempts come from the ROW, never from the request. A bound the caller
    // supplies is not a bound.
    const adapter = selectAdapter(stored.record.method, registry(stored.verifyAttempts));
    try {
      const evidence = await adapter.complete(challengeId, proof);
      const active = activate(markVerifying2(stored.record), evidence);
      const { token } = await store.consent.activate(consentId, evidence, active);
      // The token goes into an httpOnly cookie and NOT into the body. It is a
      // bearer credential: anything that can read it can open a session as
      // this child, and a response body is readable by every script on the
      // page and by anything that logs responses.
      setConsentCookie(reply, token, { env });
      // The verification is over, so the breadcrumb that pointed at it is
      // rubbish now. Clearing it also means a second finalize on the same
      // browser cannot re-enter a flow that already succeeded.
      clearIdCheckCookie(reply, { env });
      return reply.send({ ledger: active });
    } catch (e) {
      // A failed verification must NOT produce a consent. Say so plainly.
      const adapterErr = e instanceof ConsentAdapterError ? e : null;

      // Spend an attempt only when the parent got something wrong that they
      // could get right — a mismatched name. A vendor outage or a capture still
      // in progress is not their mistake and must not burn the budget that
      // decides whether they are allowed to try again.
      if (adapterErr?.code === 'name_mismatch') {
        await store.consent.noteVerifyAttempt(consentId);
      }
      // Nothing more can come of this rail, so stop pointing the browser at it.
      if (adapterErr && !adapterErr.retryable) clearIdCheckCookie(reply, { env });

      return reply.code(422).send({
        error: e instanceof Error ? e.message : 'verification failed',
        // `code` and `retryable` let the client tell "type it again" from "this
        // rail is over, take the other one" without reading English out of
        // `error`.
        code: adapterErr?.code ?? 'verification_failed',
        retryable: adapterErr?.retryable ?? false,
        status: stored.record.status,
      });
    }
  }

  app.post<{ Params: { id: string }; Body: { challengeId: string; proof?: unknown } }>(
    '/v1/consent/:id/finalize', async (req, reply) =>
      completeVerification(req.params.id, req.body.challengeId, req.body.proof, reply));

  /**
   * Finish an ID check the parent has just come back from.
   *
   * No consent id and no challenge id in the path or the body: both come from
   * the signed cookie set at `draft`, for the same reason nothing else here
   * takes an id from the client. The body carries ONE thing — the name as
   * printed on the document — and a name decides nothing on its own. The
   * verdict is fetched from the vendor by this server.
   */
  app.post<{ Body: { fullName?: string } }>('/v1/consent/verify-id', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { fullName: { type: 'string', maxLength: 120 } },
      },
    },
  }, async (req, reply) => {
    const pending = pendingIdCheck(req, await opts.keys.indexKey());
    if (!pending) {
      return reply.code(404).send({
        error: 'no ID check in progress', code: 'no_pending_check', retryable: false,
      });
    }
    return completeVerification(
      pending.consentId, pending.challengeId,
      { fullName: req.body?.fullName ?? '' }, reply);
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

  // ---- the parent dashboard (W4) ------------------------------------------

  /**
   * Resolve a request to the family it is a signed-in parent for.
   *
   * Both cookies, and they must agree. A consent cookie alone is a CHILD — the
   * browser the dashboard is being opened from is usually the child's — so
   * every route below is gated on the parent session, not on being signed in.
   */
  async function parentContext(req: FastifyRequest) {
    const stored = await consentFromCookie(req);
    if (!stored) return null;
    if (parentFor(req, await opts.keys.indexKey()) !== stored.consentId) return null;
    return stored;
  }

  const PARENT_REQUIRED = { error: 'a parent PIN is required', code: 'PARENT_REQUIRED' };

  app.get('/v1/parent/dashboard', async (req, reply) => {
    const stored = await parentContext(req);
    if (!stored) return reply.code(403).send(PARENT_REQUIRED);
    const c = stored.record;

    const data = await store.withChild(stored.childId, async (tx) => ({
      stats: await store.child.stats(tx, stored.childId),
      sessions: await store.child.sessionList(tx, stored.childId),
      memories: await store.child.listMemories(tx, stored.childId),
      flags: await store.child.listFlags(tx, stored.childId),
    }));

    return reply.send({
      child: {
        firstName: c.childFirstName, band: c.band,
        country: c.country, board: c.board,
      },
      consent: {
        law: c.law, method: c.method, status: c.status,
        issuedAt: c.issuedAt, expiresAt: c.expiresAt,
        scopes: {
          memory: c.scopes.includes('memory'),
          learning: c.scopes.includes('learning'),
        },
      },
      stats: { ...data.stats, memories: data.memories.length },
      sessions: data.sessions,
      memories: data.memories,
      // Split by kind so the client cannot accidentally render a GATE flag in
      // the safety panel. Each carries a template-authored body and, for ASSIST,
      // a constrained topic — there is no field here a child's words could be in.
      flags: {
        safety: data.flags.filter((f) => f.kind === 'SAFETY'),
        assist: data.flags.filter((f) => f.kind === 'ASSIST'),
        gate: data.flags.filter((f) => f.kind === 'GATE'),
      },
      helplines: REGISTRY[c.country],
      /**
       * There is deliberately no per-child learning queue, and this field says
       * so rather than leaving an empty panel to be misread as "nothing yet".
       *
       * `learning_insight` has no foreign key to child, session or message —
       * the loop cannot be traced back to a child because the link does not
       * exist (schema §8). A parent can see whether the family opted in; there
       * is nothing of their child's to show them, by design.
       */
      learning: {
        optedIn: c.scopes.includes('learning'),
        perChildQueueExists: false,
      },
    });
  });

  /**
   * One conversation, band-aware.
   *
   * **The teen carve-out is applied HERE as well as by the database.** The
   * schema's `teen_bodies_are_never_stored` CHECK means a thinker's `body_enc`
   * is already NULL, so this re-check is redundant today — which is exactly why
   * it is worth having. It costs nothing, and it means a future migration that
   * relaxed the constraint would not silently turn every teen's transcript into
   * a parent-readable log. Two independent controls for one promise.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/parent/sessions/:id/transcript', {
      schema: {
        params: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    }, async (req, reply) => {
      const stored = await parentContext(req);
      if (!stored) return reply.code(403).send(PARENT_REQUIRED);

      const owner = await opts.pool.query<{ child_id: string; band: string }>(
        `SELECT child_id, band FROM session WHERE id = $1`, [req.params.id]);
      const row = owner.rows[0];
      // Same 404 for "no such session" and "not your session", so the response
      // cannot be used to discover that another family's session id is real.
      if (!row || row.child_id !== stored.childId) {
        return reply.code(404).send({ error: 'no such session' });
      }

      const rows = await store.withChild(stored.childId, (tx) =>
        store.child.transcript(tx, req.params.id, stored.childId));

      const teen = row.band === 'thinker';
      return reply.send({
        band: row.band,
        /** False for a teen: the parent is told what they are NOT getting. */
        bodiesIncluded: !teen,
        note: teen
          ? 'Your teenager gets a topics-only view. We do not store what they typed, '
            + 'so there is nothing here we are choosing to withhold — there is nothing to show.'
          : null,
        turns: rows.map((t) => ({
          seq: t.seq, role: t.role, topic: t.topic,
          body: teen ? null : t.body,
        })),
      });
    });

  /**
   * Local crisis lines. Not behind the parent gate: a child in trouble should
   * be able to reach a helpline without an adult unlocking anything first.
   */
  app.get<{ Params: { country: string } }>(
    '/v1/helplines/:country', async (req, reply) => {
      const country = req.params.country.toUpperCase() as Country;
      if (!(COUNTRIES as readonly string[]).includes(country)) {
        return reply.code(404).send({ error: 'no verified helplines for that country' });
      }
      // From the live registry, falling back to the shipped copy. `status` and
      // `source` are reported rather than hidden: an ops console needs to see
      // that a market is running on the fallback, and a stale registry is a
      // thing to page about, not a thing to quietly serve.
      const r = await resolveHelplines(opts.pool, country);
      return reply.send({
        country: r.country, name: r.name, lines: r.lines,
        status: r.status, source: r.source, lastVerified: r.lastVerified,
        law: REGISTRY[country].law, consent: REGISTRY[country].consent,
      });
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
    // Resumes the live session where there is one. `resumed` and `crisisLock`
    // are returned so the client can repaint the conversation and, crucially,
    // re-apply a lock it did not witness — a reloaded page has no memory of the
    // turn that locked it.
    const s = await store.openSession(stored!.childId, stored!.consentId, c.band);
    return reply.code(201).send({
      sessionId: s.id, band: c.band, country: c.country,
      resumed: s.resumed, crisisLock: s.crisisLock,
      welcome: s.resumed
        // A resumed session repaints the conversation it already had. Opening a
        // second time with "You're back" over the top of it would be a lie about
        // what just happened.
        ? null
        : await welcomeFor(stored!.childId, c.scopes.includes('memory')),
    });
  });

  /**
   * D1/H — "Scripted welcome + one warm memory if any".
   *
   * SERVER-SIDE, and that is the whole point of moving it. Which stored fact may
   * be spoken back to a child unprompted is an allowlist decision, and the
   * client is not allowed to make those; it renders the blocks it is handed.
   *
   * The fact goes into a `text` block DIRECTLY rather than through
   * `parseBlocks`. It is model-authored text sitting in the database, and the
   * parser is the one place a string becomes UI — a memory reading
   * `likes [CHIPS]tap me[/CHIPS] puzzles` must arrive as prose, not buttons.
   *
   * Nothing here is sealed and nothing enters `history`: the welcome is not a
   * turn, and it must not become context a model builds on.
   */
  async function welcomeFor(childId: string, memOn: boolean): Promise<{
    blocks: Block[]; trace: string;
  }> {
    const memory = memOn
      ? welcomeMemory(await store.withChild(childId, (tx) =>
        store.child.listMemories(tx, childId)))
      : null;
    return {
      blocks: [{ kind: 'big', emoji: '\u{1F426}' }, { kind: 'text', text: welcomeSpine(memory) }],
      // The prototype's own label (chittu-v3.html:871), kept verbatim so the
      // trace strip reads the same on both.
      trace: memory === null ? 'SPINE \u00B7 welcome' : 'SPINE \u00B7 welcome + MEMORY',
    };
  }

  /**
   * The child's own conversation, for repainting after a reload.
   *
   * Session-scoped like the memory book: the session id is the capability the
   * caller already holds. It returns the child's OWN turns — this is not the
   * parent view and carries no flags, no trace and no other session.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/session/:id/messages', {
      schema: {
        params: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    }, async (req, reply) => {
      const owner = await opts.pool.query<{ child_id: string; band: string }>(
        `SELECT child_id, band FROM session WHERE id = $1`, [req.params.id]);
      const row = owner.rows[0];
      if (!row) return reply.code(404).send({ error: 'no such session' });

      const turns = await store.withChild(row.child_id, (tx) =>
        store.child.ownTranscript(tx, req.params.id, row.child_id));

      // A teen's words were never written down, so there is nothing to restore.
      // That is the cost of the carve-out and it is stated rather than shown as
      // an empty screen, which would read as a bug.
      const teen = row.band === 'thinker';
      return reply.send({
        restorable: !teen,
        note: teen
          ? "We don't keep what you type, so your earlier messages aren't saved. "
            + 'Chittu still remembers the nice things you chose to share.'
          : null,
        turns: teen ? [] : turns,
      });
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

      /**
       * Usage is COLLECTED during the turn and written after it commits.
       *
       * Inside the transaction, a metering failure would roll back the turn —
       * a child would lose their answer because a billing row could not be
       * written. Metering is telemetry; the seal chain is the record. Losing a
       * metering row is acceptable, and losing an answer is not.
       */
      const usage: ModelUsage[] = [];
      /**
       * What the turn observed go wrong, and the two facets a signal keeps.
       * Collected here for the same reason as `usage`: abstracting a shape and
       * counting it happens AFTER the commit, so it can never cost a child an
       * answer, and so the turn's transaction is not held open across it.
       */
      let signal: TurnSignal | undefined;
      let facets: { band: Band; country: Country } | undefined;

      const result = await store.withChild(row.child_id, async (tx) => {
        const loaded = await store.loadSession(tx, req.params.id);
        if (!loaded) return null;
        // Resolved BEFORE the pipeline runs, so a crisis reply is assembled
        // from live numbers where we have them and shipped ones where we do
        // not — and never waits on a query mid-turn.
        const helplines = await resolveHelplines(tx, loaded.state.country);
        const base = { ...loaded.state, helplines: helplines.text };
        const state = req.body.mode ? { ...base, mode: req.body.mode } : base;

        // The whole turn — seal, guards, model calls, writes — commits together
        // or not at all. A turn that fails halfway must not leave a session
        // half-guarded or a chain with a gap.
        const out = await runTurn(state, req.body.text, {
          // ctx forwarded, not dropped. A two-argument arrow here silently
          // disabled per-band and per-country classifier routing AND per-child
          // clearance, while every router test kept passing because they call
          // router.classify directly. wiring.test.ts covers the seam.
          classify: (text, history, ctx) =>
            router.classify(text, history, ctx, (u) => usage.push(u)),
          generate: (input) => router.generate(input, (u) => usage.push(u)),
          // `tx`, not `pool` — the turn's own transaction. See corpus/ground.ts.
          // Spread rather than assigned `undefined`, which `exactOptionalPropertyTypes`
          // rejects for an optional method anyway.
          ...(groundFor ? {
            ground: groundFor(tx, { band: state.band, country: state.country },
              (u) => usage.push(u)),
          } : {}),
          seal: store.sealFor(tx, req.params.id),
          now: () => new Date().toISOString(),
          newId: () => randomUUID(),
        });
        if (out.signal !== undefined) {
          signal = out.signal;
          facets = { band: state.band, country: state.country };
        }

        const replyText = flattenForStorage(out.response.blocks);

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

      /**
       * After the commit, and never able to fail the turn.
       *
       * A maths turn and a crisis turn call no vendor, so `usage` is empty and
       * nothing is written — which `metering.test.ts` asserts, because a row
       * appearing there would mean either that arithmetic reached a provider or
       * that metering is inventing spend.
       */
      if (usage.length > 0) {
        try {
          const pseudonym = sessionPseudonym(req.params.id, await opts.keys.indexKey());
          for (const u of usage) {
            const cost = costFor(u.tokensIn, u.tokensOut, rateFor(u.provider, u.model));
            await meteringRepo.record(opts.pool, pseudonym, u, cost);
          }
        } catch (e) {
          app.log.warn({ err: e }, 'metering write failed; the turn is unaffected');
        }
      }

      /**
       * SIGNAL CAPTURE (docs/chittu-model-plan.md phase 2).
       *
       * The child's sentence is abstracted to a shape and the shape is counted.
       * The sentence itself never leaves this request: `abstractShape` is a pure
       * function over a string, and `observe` writes the shape's TEXT only on
       * the turn that takes it past 25 distinct sessions.
       *
       * Nothing is captured on an ordinary turn. `signal` is set only where the
       * runtime saw something go wrong that it can name without guessing what
       * SHOULD have happened — which is why a maths turn, a crisis turn and a
       * good answer all write zero rows, and why `signals.test.ts` asserts that
       * first.
       */
      if (signal !== undefined && facets !== undefined) {
        try {
          const shape = abstractShape(req.body.text);
          if (shape !== null) {
            await signalRepo.observe(opts.pool, {
              shape,
              layer: signal.layer,
              observedToken: signal.observedToken,
              failureClass: signal.failureClass,
              band: facets.band,
              country: facets.country,
            }, req.params.id, await opts.keys.indexKey());
          }
        } catch (e) {
          app.log.warn({ err: e }, 'signal capture failed; the turn is unaffected');
        }
      }

      // The child never receives raw model text — only parsed blocks, the trace,
      // and the layers that ran.
      return reply.send(result);
    });

  // ---- the reading coach --------------------------------------------------

  /**
   * D2's RM→RC branch: score a read-aloud attempt against a bank passage.
   *
   * WHAT ARRIVES IS TEXT. The browser transcribed the child's voice and
   * discarded the audio — the same transcribe-and-discard promise the composer
   * mic makes — so no audio is ever stored or sent, here or anywhere. And that
   * browser ASR is a PLACEHOLDER, not the production path: adult-trained
   * models fail children (status §4); the Phase 2 target is our own
   * child-speech ASR.
   *
   * Scoring is DETERMINISTIC and LOCAL — the same doctrine as the maths
   * engine, for the same reason: a scorer that hallucinates a miss teaches a
   * child they got it wrong when they did not. No model call is made on this
   * route, and the tests prove it by counting against an injected router
   * rather than by inspection.
   *
   * The transcript still walks the pipeline prefix — seal → crisis-lock →
   * READ → L1 lexicon — because a child reading aloud can say something that
   * needs the crisis spine, and "they were only reading" is not a reason to
   * skip a layer. When a guard fires, the response is the guard's (no
   * `reading` payload) and the counters below are untouched.
   */
  app.post<{ Params: { id: string }; Body: { passageId: string; transcript: string } }>(
    '/v1/session/:id/read', {
      schema: {
        params: {
          type: 'object', required: ['id'], additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object', required: ['passageId', 'transcript'], additionalProperties: false,
          properties: {
            passageId: { type: 'string', minLength: 1, maxLength: 40 },
            transcript: { type: 'string', minLength: 1, maxLength: 2000 },
          },
        },
      },
    }, async (req, reply) => {
      // The passage is resolved HERE, before the pipeline, so `runTurn` stays
      // a pure function of its inputs — the same shape as helplines. An
      // unknown id is a client defect and is refused in words.
      const passage = passageById(req.body.passageId);
      if (!passage) return reply.code(404).send({ error: 'no such passage' });

      const owner = await opts.pool.query<{ child_id: string; ended_at: string | null }>(
        `SELECT child_id, ended_at FROM session WHERE id = $1`, [req.params.id]);
      const row = owner.rows[0];
      if (!row) return reply.code(404).send({ error: 'no such session' });
      if (row.ended_at) return reply.code(409).send({ error: 'session ended' });

      /**
       * Collected exactly as /turn collects it — and expected to stay EMPTY.
       * The ports are wired so that if a reading turn ever did reach a vendor,
       * the spend would be metered rather than invisible; `metering.test.ts`
       * asserts no row appears, which is the observable form of "zero model
       * calls". There is no signal-capture block: the read path ends before
       * the classifier and the sandbox, the only layers that can observe a
       * failure worth capturing.
       */
      const usage: ModelUsage[] = [];

      const result = await store.withChild(row.child_id, async (tx) => {
        const loaded = await store.loadSession(tx, req.params.id);
        if (!loaded) return null;
        const helplines = await resolveHelplines(tx, loaded.state.country);
        const state = { ...loaded.state, helplines: helplines.text, mode: 'read' as const };

        const out = await runTurn(state, req.body.transcript, {
          classify: (text, history, ctx) =>
            router.classify(text, history, ctx, (u) => usage.push(u)),
          generate: (input) => router.generate(input, (u) => usage.push(u)),
          seal: store.sealFor(tx, req.params.id),
          now: () => new Date().toISOString(),
          newId: () => randomUUID(),
        }, { passage });

        await store.saveTurn(
          tx, req.params.id, loaded.childId, state.band, out.state,
          'read', req.body.transcript, flattenForStorage(out.response.blocks),
          out.response.trace, out.response.layers,
          out.response.flags.map((f) => f.assistTopic !== undefined
            ? { kind: f.kind, noteKey: f.noteKey, assistTopic: f.assistTopic }
            : { kind: f.kind, noteKey: f.noteKey }),
          out.response.memorySaved);

        // Counters move only on a SCORED attempt — a guarded turn was never
        // scored, and counting it would fold crisis turns into a reading stat.
        if (out.response.reading) {
          await store.child.recordReading(
            tx, req.params.id, out.response.reading.total, out.response.reading.hits);
        }
        return out.response;
      });

      if (!result) return reply.code(404).send({ error: 'no such session' });

      if (usage.length > 0) {
        try {
          const pseudonym = sessionPseudonym(req.params.id, await opts.keys.indexKey());
          for (const u of usage) {
            const cost = costFor(u.tokensIn, u.tokensOut, rateFor(u.provider, u.model));
            await meteringRepo.record(opts.pool, pseudonym, u, cost);
          }
        } catch (e) {
          app.log.warn({ err: e }, 'metering write failed; the turn is unaffected');
        }
      }

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

  /**
   * D5/SEAL — "Verify seal integrity / recompute every hash", over EVERY
   * conversation the child has had.
   *
   * The per-session route below answers for one chain, and it is the one the
   * child's own tab can ask about. It is not what a parent is asking. A parent
   * pressing "verify" means "has anything been edited?", and the prototype's
   * button recomputed the lot from GENESIS — a hundred conversations, including
   * the ones this browser never opened and holds no id for.
   *
   * Behind the parent gate rather than the consent cookie, because it enumerates
   * how many conversations a child has had. A consent cookie alone is a CHILD.
   */
  app.get('/v1/parent/seal', async (req, reply) => {
    const stored = await parentContext(req);
    if (!stored) return reply.code(403).send(PARENT_REQUIRED);
    const v = await store.audit.verifyChild(stored.childId);
    return reply.send({
      ok: v.ok, sessions: v.sessions, records: v.records, broken: v.broken,
    });
  });

  // ---- the two D5 nodes the port left behind ------------------------------

  /**
   * D5/HARNESS — five live sums, graded against answers a person wrote down.
   *
   * Behind the parent gate like every other route here, and it reaches NO
   * MODEL: `mathTurn` is the same layer a child's arithmetic takes, and it
   * returns above `L2_CLASSIFIER`. The prototype's harness graded a model
   * instead, which audited a path a child's sums do not take and made five
   * vendor calls from a dashboard to do it. `certification.test.ts` counts.
   *
   * Run at THIS child's band and board, so a parent is shown the engine as
   * their child actually has it configured, not a generic one.
   */
  app.get('/v1/parent/maths-check', async (req, reply) => {
    const stored = await parentContext(req);
    if (!stored) return reply.code(403).send(PARENT_REQUIRED);
    const c = stored.record;
    return reply.send(runMathsHarness({
      band: c.band, board: c.board, kid: c.childFirstName,
    }));
  });

  /**
   * D5/CERT — the readiness checklist, probed rather than maintained.
   *
   * Behind the parent gate because it enumerates this deployment's controls and
   * their gaps: the consent method, the key custody, the state of the helpline
   * registry and how many conversations there have been. A consent cookie alone
   * is a CHILD.
   *
   * Nothing it returns can carry a child's words — every string is composed
   * here from counts, role names and constraint names, and a test greps the
   * whole response for a distinctive sentence a child typed.
   */
  app.get('/v1/parent/certification', async (req, reply) => {
    const stored = await parentContext(req);
    if (!stored) return reply.code(403).send(PARENT_REQUIRED);
    const c = stored.record;
    const seal = await store.audit.verifyChild(stored.childId);
    return reply.send(await buildCertification({
      pool: opts.pool,
      childId: stored.childId,
      country: c.country,
      consentMethod: c.method,
      consentLaw: c.law,
      seal: { ok: seal.ok, sessions: seal.sessions, records: seal.records },
      maths: { band: c.band, board: c.board, kid: c.childFirstName },
    }));
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
    /**
     * D4/UN — "Chat unlocked + gentle welcome-back message".
     *
     * The route used to lift the lock and send nothing, so the child's screen
     * simply stopped being paused. This says the one thing that is true and
     * that a model must never be asked to phrase: a person checked in.
     *
     * SCRIPTED, from the kernel. And it is NOT a turn — nothing is written to
     * `message`, nothing joins `history`, nothing joins the classifier window.
     * A scripted reply is not context for a model to build on, and the turn
     * that put the child here is exactly the one that must not be built on.
     */
    return reply.send({
      crisisLock: false,
      welcomeBack: {
        blocks: [{ kind: 'text', text: CRISIS_WELCOME_BACK.en }] satisfies Block[],
        trace: 'SPINE \u00B7 welcome-back',
      },
    });
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

/**
 * What Chittu SAID, flattened for storage.
 *
 * Chips are excluded, and that is a correction rather than a shortcut. They
 * are suggested next taps — navigation, not utterance — and appending their
 * labels to the prose produced lines like "I'm still learning that one! Tell
 * me more Something else", which reads as if Chittu said it. That went to a
 * parent's transcript, and once a reloaded page repaints from the same text,
 * to the child as well.
 *
 * The `big` emoji is kept: it is decorative, but it is on screen.
 */
function flattenForStorage(blocks: readonly Block[]): string {
  return blocks
    .filter((b) => b.kind !== 'chips')
    .map((b) => (b.kind === 'steps' ? b.items.join(' ')
      : b.kind === 'big' ? b.emoji : b.text))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
