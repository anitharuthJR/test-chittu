/**
 * What happens when there is no database to bootstrap.
 *
 * The interesting case is the one a container produces: the production image
 * carries no devDependencies, so `@electric-sql/pglite` is not installed in it.
 * Run that image with NODE_ENV=development and no DATABASE_URL — which the dev
 * compose profile does — and the PGlite branch is reached in an image that
 * cannot satisfy it. Observed as a raw ERR_MODULE_NOT_FOUND stack with no clue
 * about the actual cause, which is a missing DATABASE_URL.
 */
import { describe, it, expect } from 'vitest';
import { bootstrapDb } from './db-bootstrap.js';

const missingModule = () => {
  const e = new Error("Cannot find package '@electric-sql/pglite'") as Error & { code: string };
  e.code = 'ERR_MODULE_NOT_FOUND';
  return Promise.reject(e);
};

describe('bootstrapDb without a database', () => {
  it('refuses in production, naming DATABASE_URL', async () => {
    await expect(bootstrapDb({ NODE_ENV: 'production' })).rejects.toThrow(/DATABASE_URL/);
  });

  it('explains itself when PGlite is not installed, instead of ERR_MODULE_NOT_FOUND', async () => {
    const err = await bootstrapDb({ NODE_ENV: 'development' }, missingModule)
      .then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // The message has to name the fix, because the person reading it is looking
    // at a container that exited two seconds after starting.
    expect(err!.message).toMatch(/DATABASE_URL/);
    expect(err!.message).toMatch(/pglite/i);
    // And it must not simply re-throw the resolver's error, which is the bug.
    expect(err!.message).not.toMatch(/^Cannot find package/);
  });

  it('does not swallow an unrelated PGlite failure', async () => {
    const boom = () => Promise.reject(new Error('WASM heap exhausted'));
    await expect(bootstrapDb({ NODE_ENV: 'development' }, boom))
      .rejects.toThrow(/WASM heap exhausted/);
  });
});
