/**
 * The fixture's own preconditions.
 *
 * `createTestDb` used to answer "no DATABASE_URL" by silently building a PGlite
 * database instead. Now it refuses — and how it refuses matters, because it
 * refuses once per test file. A bare ECONNREFUSED, repeated 14 times, reads as
 * "the suite is broken"; the fix it actually needs is one command.
 *
 * These run without touching a server, which is the point: they are about the
 * message, not the database.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from './testing.js';

describe('createTestDb preconditions', () => {
  it('refuses without DATABASE_URL rather than falling back to another engine', async () => {
    await expect(createTestDb({})).rejects.toThrow(/DATABASE_URL/);
  });

  it('names the command that fixes it', async () => {
    const err = await createTestDb({}).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/pnpm db:up/);
  });

  // The likely failure now that vitest.config.ts defaults the URL: the variable
  // is set and nothing is listening. That must not surface as a driver error.
  it('turns a refused connection into the prerequisite, not ECONNREFUSED', async () => {
    // Port 1 is privileged and unbound — a connection there is refused at once.
    const err = await createTestDb({
      DATABASE_URL: 'postgres://chittu:chittu@127.0.0.1:1/chittu_test',
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/cannot reach Postgres/);
    expect(err!.message).toMatch(/pnpm db:up/);
    // The host, so the reader can tell which database was not reachable —
    // and no credentials, because this lands in CI logs.
    expect(err!.message).toMatch(/127\.0\.0\.1:1/);
    expect(err!.message).not.toMatch(/chittu:chittu/);
  });
});
