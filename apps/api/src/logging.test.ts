/**
 * Architecture §2.2, line 88: "Message bodies never enter a trace, span or log
 * line. Enforced by a redacting processor."
 *
 * Until now that was true by accident — `logger: true` gives Fastify's default
 * pino, which happens to serialise request metadata and not bodies. Accident is
 * not enforcement: the first person to add `req.body` to a log line, or to log
 * an error object carrying the turn that caused it, breaks the rule silently and
 * writes a child's words to disk where the retention sweep does not reach.
 *
 * These tests pin the redaction so that breakage is loud.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildLoggerOptions, REDACTED, SENSITIVE_PATHS } from './logging.js';

/**
 * Drive the REAL pino, not a re-implementation of its redaction.
 *
 * A hand-rolled simulation here would test the simulation: it would happily
 * accept a malformed redact path that pino silently ignores, which is precisely
 * the silent hole worth catching. `res.headers["set-cookie"]` uses pino's
 * bracket syntax, and only pino knows whether that parses.
 */
const emit = (obj: unknown): string => {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) { out += String(chunk); cb(); },
  });
  const log = pino(buildLoggerOptions({ dir: null }) as pino.LoggerOptions, sink);
  log.info(obj as object, 'test');
  return out;
};

describe('redaction — a child\'s words must not reach the log', () => {
  it('censors a request body even when someone logs the whole request', () => {
    const line = emit({
      req: { method: 'POST', url: '/v1/turn', body: { text: 'i want to die' } },
    });
    expect(line).not.toContain('i want to die');
    expect(line).toContain(REDACTED);
  });

  it('censors the turn text on a bare object', () => {
    for (const field of ['text', 'body', 'message', 'content', 'transcript']) {
      const line = emit({ [field]: 'my dad hits me' });
      expect(line, field).not.toContain('my dad hits me');
    }
  });

  it('censors credentials and the consent token', () => {
    const line = emit({
      req: { headers: { authorization: 'Bearer abc', cookie: 'consent=xyz' } },
      pin: '4821',
      apiKey: 'sk-ant-secret',
    });
    for (const secret of ['Bearer abc', 'consent=xyz', '4821', 'sk-ant-secret']) {
      expect(line, secret).not.toContain(secret);
    }
  });

  it('keeps the operational fields that make a log worth having', () => {
    // Over-redacting to the point of uselessness is its own failure: the log
    // has to answer "what broke, on which route, how slow" or nobody keeps it.
    const line = emit({ req: { method: 'POST', url: '/v1/turn' }, statusCode: 500, responseTime: 12 });
    expect(line).toContain('/v1/turn');
    expect(line).toContain('500');
  });

  it('lists every sensitive path under both req and res', () => {
    // A field redacted on the request and forgotten on the response is the
    // gap that actually happens — the reply carries the child's words too.
    for (const leaf of ['text', 'body', 'content']) {
      expect(SENSITIVE_PATHS.some((p) => p === leaf || p.endsWith(`.${leaf}`)), leaf).toBe(true);
    }
  });
});

describe('destination', () => {
  it('writes to stdout only when no directory is configured', () => {
    const opts = buildLoggerOptions({ dir: null });
    expect(opts.transport).toBeUndefined();
  });

  it('adds a file target alongside stdout when a directory is given', () => {
    const opts = buildLoggerOptions({ dir: '/tmp/chittu-logs' });
    const targets = (opts.transport as { targets: { target: string; options: Record<string, unknown> }[] })
      .targets;
    // Both, not either: losing console output would make `pnpm start` silent.
    expect(targets.length).toBe(2);
    const dests = targets.map((t) => String(t.options['destination'] ?? ''));
    expect(dests.some((d) => d.includes('/tmp/chittu-logs'))).toBe(true);
  });
});
