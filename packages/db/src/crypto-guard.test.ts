/**
 * The guard that decides whether a LOCAL master key is allowed to run.
 *
 * This file exists because the original guard was a denylist — `env === 'prod'`
 * — and the production image sets NODE_ENV=`production`. Those two strings are
 * not equal, so the guard never fired: every ECS task would have booted with an
 * ephemeral `randomBytes(32)` master key, a DIFFERENT one per task and per
 * restart. Parent email, parent name, child first name, message bodies and
 * memory facts would each have been written under a key nothing else could
 * read, and the email blind index — derived from the same key — would have made
 * a parent unfindable from any other task.
 *
 * The bug was not the mismatch. The bug was that an UNRECOGNISED value defaulted
 * to permitted. So the guard is an allowlist now, and this file pins the
 * vocabulary from both ends.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { localKeyProvider, deploymentEnv, CryptoError } from './crypto.js';

const key = () => randomBytes(32);

describe('deploymentEnv', () => {
  it('maps NODE_ENV=production onto the schema vocabulary', () => {
    // `deployment.env` is CHECK (env IN ('dev','staging','prod')) — 'production'
    // is not a value the database accepts, and migrate.ts already mapped it.
    expect(deploymentEnv({ NODE_ENV: 'production' })).toBe('prod');
  });

  it('treats everything else as dev', () => {
    expect(deploymentEnv({ NODE_ENV: 'development' })).toBe('dev');
    expect(deploymentEnv({ NODE_ENV: 'test' })).toBe('dev');
    expect(deploymentEnv({})).toBe('dev');
  });
});

describe('localKeyProvider refuses anything that is not explicitly dev', () => {
  it('permits dev', () => {
    expect(() => localKeyProvider(key(), 'dev')).not.toThrow();
  });

  /**
   * 'production' is THE regression. It is what the Dockerfile sets and what
   * db-bootstrap passed straight through, and the old denylist let it past.
   */
  it.each(['production', 'prod', 'staging', 'test', 'Dev', 'DEV', '', 'produciton'])(
    'refuses %o',
    (env) => {
      expect(() => localKeyProvider(key(), env)).toThrow(CryptoError);
    },
  );

  it('names the value it refused, so the message is actionable', () => {
    expect(() => localKeyProvider(key(), 'production'))
      .toThrow(/production/);
  });

  it('refuses NODE_ENV=production routed through deploymentEnv', () => {
    // The real call path, end to end: the image's NODE_ENV must not yield a
    // local key provider no matter which of the two layers you delete.
    const env = deploymentEnv({ NODE_ENV: 'production' });
    expect(() => localKeyProvider(key(), env)).toThrow(CryptoError);
  });
});
