/**
 * What happens when there is no database to bootstrap.
 *
 * There is exactly one answer now, and that is the point of this file. The API
 * used to fall back to PGlite whenever DATABASE_URL was absent outside
 * production, which meant "no database configured" was a state the process could
 * boot straight through — on a schema that had never run the pgvector DDL. Now
 * the absence is refused everywhere, and the refusal has to name the fix,
 * because the person reading it is looking at a container that exited two
 * seconds after starting.
 */
import { describe, it, expect } from 'vitest';
import { bootstrapDb } from './db-bootstrap.js';

describe('bootstrapDb without a database', () => {
  it('refuses in production, naming DATABASE_URL', async () => {
    await expect(bootstrapDb({ NODE_ENV: 'production' })).rejects.toThrow(/DATABASE_URL/);
  });

  // The regression this pins: development used to be the branch that did NOT
  // refuse. A fallback here is what let a laptop and a deployment run different
  // schemas without anyone choosing that.
  it('refuses in development too — there is no fallback engine any more', async () => {
    await expect(bootstrapDb({ NODE_ENV: 'development' })).rejects.toThrow(/DATABASE_URL/);
  });

  it('refuses with NODE_ENV unset', async () => {
    await expect(bootstrapDb({})).rejects.toThrow(/DATABASE_URL/);
  });

  it('names the command that fixes it, not just the variable', async () => {
    const err = await bootstrapDb({}).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/pnpm db:up/);
  });

  // A refusal that arrives as a connection error is a worse refusal: it sends
  // the reader to look at the database instead of at their configuration.
  it('fails before opening a connection, so the error is about config', async () => {
    const err = await bootstrapDb({}).then(() => null, (e: Error) => e);
    expect(err!.message).not.toMatch(/ECONNREFUSED|ENOTFOUND|connect/i);
  });
});
