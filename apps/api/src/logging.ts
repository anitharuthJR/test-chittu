/**
 * Where the application logs go, and what may be in them.
 *
 * Architecture §2.2: "Message bodies never enter a trace, span or log line.
 * Enforced by a redacting processor." Before this module that enforcement did
 * not exist — `logger: true` gave Fastify's stock pino, which serialises
 * request metadata and not bodies, so the rule held by accident. The first
 * person to log `req.body`, or to log an error object carrying the turn that
 * caused it, would have written a child's words to disk with nothing objecting.
 *
 * Two things are deliberate:
 *
 *  - Redaction is a DENY-LIST OF PATHS, not a scrub of the final string. A
 *    string scrub cannot tell "i want to die" from ordinary prose, so it would
 *    either miss everything or destroy the log. Naming the fields that carry a
 *    child's words is the only version that is checkable — and `logging.test.ts`
 *    is what checks it.
 *
 *  - Console output is never traded away for the file. A `pnpm start` that
 *    prints nothing looks broken, and someone will "fix" it by removing the
 *    file target rather than adding the console one back.
 *
 * Log FILES are development scaffolding. In production §14 puts stdout into a
 * CloudWatch log group with the same redaction filter, because a file on a task
 * that can be replaced at any moment is not a record anyone can rely on. Nothing
 * here is the audit trail: that is the seal chain, and it is in Postgres.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What a censored value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Fields that can carry a child's words, a credential, or a session secret.
 *
 * Listed for both `req` and `res`: a field redacted on the way in and forgotten
 * on the way out is the gap that actually happens, because the reply carries the
 * child's turn back. Bare leaves are included too, so an object logged directly
 * — `log.error({ text }, '…')` — is covered as well as a nested one.
 */
export const SENSITIVE_PATHS: readonly string[] = Object.freeze([
  // A child's turn, and the reply to it.
  'text', 'body', 'message', 'content', 'transcript', 'reply', 'prompt',
  'req.body', 'req.text', 'req.body.text', 'res.body', 'res.text',
  // Memory Book facts are allowlisted personalisation, still not log material.
  'fact', 'memory', 'memories',
  // Credentials and session secrets.
  'pin', 'apiKey', 'api_key', 'token', 'password', 'secret',
  // The identity-verification vendor's decision payload. The client narrows it
  // before it can reach a caller, so these should never appear — listed anyway,
  // because "should never" and "cannot" are different guarantees and this is
  // the cheaper of the two.
  'fullName', 'full_name', 'first_name', 'last_name', 'date_of_birth',
  'document_number', 'mrz', 'portrait_image', 'front_image', 'back_image',
  'documentName', 'vendor_data', 'x-api-key', 'req.headers["x-api-key"]',
  'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
  'headers.authorization', 'headers.cookie',
]);

export interface LoggerDestination {
  /** Directory for `api.log`, or null for stdout only. */
  readonly dir: string | null;
}

/** Shape pino accepts; kept loose so this module owns no pino types. */
export interface LoggerOptions {
  readonly level: string;
  readonly redact: { paths: string[]; censor: string };
  readonly transport?: {
    targets: { target: string; level: string; options: Record<string, unknown> }[];
  };
}

/**
 * Build the logger config.
 *
 * `dir` is resolved by the caller rather than read from the environment here,
 * so this stays a pure function and the tests need no filesystem.
 */
export function buildLoggerOptions(dest: LoggerDestination): LoggerOptions {
  const base: LoggerOptions = {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: [...SENSITIVE_PATHS], censor: REDACTED },
  };

  if (dest.dir === null) return base;

  return {
    ...base,
    transport: {
      targets: [
        // Console. `pino/file` with destination 1 IS stdout — deliberately not
        // pino-pretty, which is not a dependency here and whose absence is a
        // runtime crash inside a worker thread rather than a startup error.
        // Pipe through `pnpm exec pino-pretty` if you want it readable.
        { target: 'pino/file', level: base.level, options: { destination: 1 } },
        // …and machine-readable on disk, which is what you grep at 2am.
        {
          target: 'pino/file',
          level: base.level,
          options: { destination: join(dest.dir, 'api.log'), mkdir: true },
        },
      ],
    },
  };
}

/**
 * Resolve the log directory from the environment and make sure it exists.
 *
 * `LOG_DIR=` (explicitly empty) disables file logging, which is what containers
 * want: in production stdout is the transport and a file is dead weight.
 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['LOG_DIR'];
  if (configured === '') return null;
  if (env['NODE_ENV'] === 'production' && configured === undefined) return null;
  if (configured !== undefined) {
    mkdirSync(configured, { recursive: true });
    return configured;
  }
  // Default relative to the REPO ROOT, not the working directory. `pnpm start`
  // runs from the root and `pnpm --filter @chittu/api dev` runs from apps/api;
  // a bare 'logs' put them in two different places, and the second one is
  // invisible to anyone looking where the docs said to look. Observed.
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = join(root, 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}
