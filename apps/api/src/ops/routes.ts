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
import { loginPage, routingPage } from './page.js';

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
  };
}
