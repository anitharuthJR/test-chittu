/**
 * The ops console's routes.
 *
 * REGISTERED ONLY WHEN OPERATORS ARE CONFIGURED. Not 403 — absent. A console
 * that exists on every deployment and is merely "protected" is a larger surface
 * than one that is not there, and every deployment that never meant to have an
 * ops console is one where the login form is pure attack surface.
 *
 * Encapsulated as a Fastify plugin so its urlencoded body parser and its cookie
 * path stay scoped to /ops and cannot change how the child-facing API parses
 * anything.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DbPool, KeyProvider } from '@chittu/db';
import { BANDS, COUNTRIES, type Band, type Country } from '@chittu/contracts';
import {
  CATEGORIES, MODEL_CATALOGUE, readCells, resolveCells,
} from '../providers/cells.js';
import {
  operatorForToken, operatorFor, setOpsCookie, clearOpsCookie,
} from './auth.js';
import {
  FAILURE_CLASSES, LAYERS, TOKENS, loginPage, routingPage, signalsPage,
} from './page.js';
import { signalRepo, DuplicateExample, SameEyes, EXAMPLE_SPLITS } from '@chittu/db';

export interface OpsOptions {
  readonly pool: DbPool;
  readonly keys: KeyProvider;
  readonly operators: ReadonlyMap<string, string>;
  readonly secure: boolean;
}

const HISTORY_SQL = `
  SELECT category, provider, model, band, country, changed_by, reason, changed_at
    FROM provider_cell ORDER BY changed_at DESC, id DESC LIMIT 50`;

/**
 * A FACTORY, not a plugin taking options.
 *
 * `app.register(plugin, opts)` does hand opts to the plugin, but what arrives is
 * not always what was passed — Fastify owns that object and merges its own keys
 * into it. `keys` came through undefined, and the symptom was a 500 from
 * `indexKey()` rather than anything that named the cause. Closing over the
 * config removes the question.
 */
export function opsRoutes(opts: OpsOptions) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    /**
     * Forms, not JSON, because the console ships no JavaScript. Eight lines
     * instead of a dependency, and scoped to this plugin so the child-facing API
     * keeps accepting exactly what it accepted before.
     */
    app.addContentTypeParser(
      'application/x-www-form-urlencoded', { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (e) { done(e as Error, undefined); }
      });

    const html = (reply: FastifyReply, code: number, body: string) =>
      reply.code(code).header('content-type', 'text/html; charset=utf-8')
        // The console renders operator-written text and nothing else; no scripts,
        // no images, no frames. Saying so is cheap and closes the injection class
        // that `esc` already closes, twice.
        .header('content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        .header('referrer-policy', 'no-referrer')
        .send(body);

    async function who(req: FastifyRequest): Promise<string | null> {
      return operatorFor(req, await opts.keys.indexKey());
    }

    async function view(operator: string, extra: {
      preview?: { band: string; country: string }; error?: string;
    } = {}) {
      const resolved = resolveCells({ env: process.env, rows: await readCells(opts.pool) });
      const { rows } = await opts.pool.query<never>(HISTORY_SQL);
      return routingPage({
        operator, resolved, history: rows as never,
        preview: extra.preview, error: extra.error,
      });
    }

    app.get('/ops', async (req, reply) => {
      const operator = await who(req);
      if (operator === null) return html(reply, 200, loginPage());
      return reply.code(303).header('location', '/ops/routing').send();
    });

    app.post<{ Body: { token?: string } }>('/ops/login', {
      config: {
        // Tighter than the global limit. A bearer token is guessable in principle
        // and this is the only route where guessing is useful.
        rateLimit: { max: 10, timeWindow: '5 minutes' },
      },
    }, async (req, reply) => {
      const operator = operatorForToken(req.body?.token, opts.operators);
      if (operator === null) {
        return html(reply, 401, loginPage('That token is not recognised.'));
      }
      setOpsCookie(reply, operator, await opts.keys.indexKey(), opts.secure);
      return reply.code(303).header('location', '/ops/routing').send();
    });

    app.post('/ops/logout', async (_req, reply) => {
      clearOpsCookie(reply, opts.secure);
      return reply.code(303).header('location', '/ops').send();
    });

    app.get<{ Querystring: { band?: string; country?: string } }>(
      '/ops/routing', async (req, reply) => {
        const operator = await who(req);
        if (operator === null) return html(reply, 401, loginPage('Please sign in.'));
        const band = req.query.band ?? '';
        const country = req.query.country ?? '';
        return html(reply, 200, await view(operator, {
          preview: { band, country },
        }));
      });

    app.post<{
      Body: { category?: string; pair?: string; band?: string; country?: string; reason?: string };
    }>('/ops/routing', async (req, reply) => {
      const operator = await who(req);
      if (operator === null) return html(reply, 401, loginPage('Please sign in.'));

      const b = req.body ?? {};
      const category = (b.category ?? '').trim();
      const pair = (b.pair ?? '').trim();
      const reason = (b.reason ?? '').trim();
      const band = (b.band ?? '').trim();
      const country = (b.country ?? '').trim();

      const bad = (msg: string) => view(operator, { error: msg })
        .then((page) => html(reply, 400, page));

      if (!(CATEGORIES as readonly string[]).includes(category)) {
        return bad(`"${category}" is not a routing category.`);
      }
      const at = pair.indexOf(':');
      if (at <= 0) return bad('Pick a model.');
      const provider = pair.slice(0, at);
      const model = pair.slice(at + 1);

      // The same catalogue check the router and the CLI make. Made here too so a
      // hand-crafted POST cannot land a row the API would read, reject and ignore
      // — which would leave the console showing a change that is not in effect.
      const models = MODEL_CATALOGUE[provider];
      if (models === undefined || !models.includes(model)) {
        return bad(`${provider}/${model} is not in the compiled catalogue.`);
      }
      if (band !== '' && !(BANDS as readonly string[]).includes(band)) {
        return bad(`"${band}" is not a band.`);
      }
      if (country !== '' && !(COUNTRIES as readonly string[]).includes(country)) {
        return bad(`"${country}" is not a country.`);
      }
      // Mirrors the CHECK constraint, so the operator gets a sentence instead of
      // a database error.
      if (reason.length < 8) {
        return bad('Give a reason — this is the field an incident review reads.');
      }

      await opts.pool.query(
        `INSERT INTO provider_cell
           (category, provider, model, band, country, changed_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [category, provider, model,
          band === '' ? null : band as Band,
          country === '' ? null : country as Country,
          // From the SESSION. Never from the form — a `changed_by` field in the
          // body is ignored, and a test posts one to prove it.
          operator, reason]);

      return reply.code(303).header('location', '/ops/routing').send();
    });

    // ---- signals (phase 4) ------------------------------------------------

    /**
     * PLUGIN-SCOPED, and registered before the routes that need it.
     *
     * The application's own error handler is registered on the root instance
     * AFTER this plugin, so /ops routes were still on Fastify's default: a JSON
     * body carrying `err.message` verbatim, with no CSP header. `promote()`
     * throws by design, and one of the things it throws is
     * "below the k-anonymity floor: 7 of 25 sessions" — the exact number the
     * floor exists to withhold, handed to a browser.
     */
    app.setErrorHandler(async (err, req, reply) => {
      req.log.warn({ err }, 'ops console error');
      const operator = await who(req);
      if (operator === null) return html(reply, 500, loginPage('Something went wrong.'));
      // The message is NOT echoed. Operators get a sentence; the detail is in
      // the log, which is where a detail that might carry a count belongs.
      return html(reply, 500, await signalsView(operator, {
        error: 'Something went wrong, and it is in the log rather than on this page.',
      }));
    });

    async function signalsView(operator: string, extra: {
      error?: string; draft?: Record<string, string>;
    } = {}) {
      const [ready, subFloor, promoted, pending] = await Promise.all([
        signalRepo.listReady(opts.pool),
        signalRepo.subFloorCount(opts.pool),
        signalRepo.listPromoted(opts.pool),
        opts.pool.query<never>(
          `SELECT id, slice, prompt, completion, label, split::text AS split, authored_by
             FROM training_example
            WHERE state = 'PENDING_HUMAN_REVIEW'
            ORDER BY created_at DESC LIMIT 50`).then((r) => r.rows),
      ]);
      return signalsPage({
        operator, operatorCount: opts.operators.size,
        ready: ready as never, subFloor, promoted: promoted as never,
        pending: pending as never,
        error: extra.error, draft: extra.draft,
      });
    }

    app.get('/ops/signals', async (req, reply) => {
      const operator = await who(req);
      if (operator === null) return html(reply, 401, loginPage('Please sign in.'));
      return html(reply, 200, await signalsView(operator));
    });

    /**
     * Every signals route takes its subject IN THE BODY, never in a path
     * segment or a query string. `req.url` is logged unredacted next to the
     * caller's address (apps/api/src/logging.ts), so a shape handle in a URL
     * is a shape handle in a log file.
     */
    app.post<{ Body: Record<string, string> }>('/ops/signals/promote', async (req, reply) => {
      const operator = await who(req);
      if (operator === null) return html(reply, 401, loginPage('Please sign in.'));
      const b = req.body ?? {};
      const bad = async (m: string) =>
        html(reply, 400, await signalsView(operator, { error: m, draft: b }));

      if (!/^[0-9a-f]{64}$/.test(b['handle'] ?? '')) return bad('Pick a shape from the queue.');
      if (!FAILURE_CLASSES.includes(b['failure_class'] ?? '')) {
        return bad('Say what went wrong.');
      }
      const expected = b['expected_token'] ?? '';
      if (!TOKENS.includes(expected)) return bad('Say what should have happened.');
      const layer = b['observed_layer'] ?? '';
      if (layer !== '' && !LAYERS.includes(layer)) return bad('That is not a pipeline layer.');

      /**
       * ONE TRANSACTION. `promote()` INSERTs the signal then UPDATEs the
       * counter's `promoted_to`; a failure between them leaves a signal nobody
       * can reach and turns the operator's retry into a duplicate-key 500.
       */
      try {
        await opts.pool.transaction((tx) => signalRepo.promote(
          tx, Buffer.from(b['handle']!, 'hex'),
          layer === ''
            ? { failureClass: b['failure_class']!, expectedToken: expected }
            : { failureClass: b['failure_class']!, expectedToken: expected, observedLayer: layer }));
      } catch (e) {
        // The message is shaped for an operator and carries no count: the only
        // reachable failures here are "already promoted" and the multi-layer
        // refusal, both of which say what to do next.
        return bad(e instanceof Error && /already promoted|more than one layer/.test(e.message)
          ? e.message
          : 'That shape could not be triaged. Reload and try again.');
      }
      return reply.code(303).header('location', '/ops/signals').send();
    });

    app.post<{ Body: Record<string, string> }>('/ops/signals/examples', async (req, reply) => {
      const operator = await who(req);
      if (operator === null) return html(reply, 401, loginPage('Please sign in.'));
      const b = req.body ?? {};
      const bad = async (m: string) =>
        html(reply, 400, await signalsView(operator, { error: m, draft: b }));

      const signalId = (b['signal_id'] ?? '').trim();
      const slice = (b['slice'] ?? '').trim();
      const prompt = (b['prompt'] ?? '').trim();
      const completion = (b['completion'] ?? '').trim();
      const label = (b['label'] ?? '').trim();
      const split = (b['split'] ?? '').trim();

      if (signalId === '') return bad('Pick a signal.');
      if (slice.length < 3) return bad('Give the example a slice — it is how a dataset excludes it later.');
      if (prompt.length < 3) return bad('Write what a child types.');
      if (completion.length < 3) return bad('Write what Chittu should say.');
      if (label !== '' && !TOKENS.includes(label) && label !== 'SAFE') return bad('That is not a label.');
      if (!(EXAMPLE_SPLITS as readonly string[]).includes(split)) return bad('Pick a split.');

      try {
        await signalRepo.authorExample(opts.pool, {
          signalId, slice, prompt, completion,
          label: label === '' ? null : label,
          split,
          // From the SESSION. An `authored_by` in the body is ignored, and a
          // test posts one — because this field is what four-eyes rests on.
          authoredBy: operator,
        });
      } catch (e) {
        if (e instanceof DuplicateExample) return bad(e.message);
        throw e;
      }
      return reply.code(303).header('location', '/ops/signals').send();
    });

    app.post<{ Body: Record<string, string> }>('/ops/examples/review', async (req, reply) => {
      const operator = await who(req);
      if (operator === null) return html(reply, 401, loginPage('Please sign in.'));
      const b = req.body ?? {};
      const bad = async (m: string) =>
        html(reply, 400, await signalsView(operator, { error: m, draft: b }));

      const id = (b['example_id'] ?? '').trim();
      const state = b['state'] ?? '';
      if (id === '') return bad('Pick an example.');
      if (state !== 'APPROVED' && state !== 'REJECTED') return bad('Approve or reject.');
      if (opts.operators.size < 2) {
        return bad('Only one operator is configured, so nobody here can review somebody '
          + "else's work. Configure a second operator first.");
      }

      try {
        // `reviewedBy` from the SESSION, never the body — the whole four-eyes
        // guarantee is that this name is not the author's, and a form field
        // would let one person supply both.
        await signalRepo.reviewExample(opts.pool, id, { state, reviewedBy: operator });
      } catch (e) {
        if (e instanceof SameEyes) return bad(e.message);
        throw e;
      }
      return reply.code(303).header('location', '/ops/signals').send();
    });
  };
}
