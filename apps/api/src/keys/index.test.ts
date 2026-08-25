/**
 * Choosing a key provider from the environment.
 *
 * The FIRST test in this file is the one whose absence let the original bug
 * ship. `localKeyProvider`'s guard was tested by passing it the literal string
 * 'prod' — which no call site ever passes — while the real path handed it
 * NODE_ENV=`production` and sailed through. Nothing tested the real path. This
 * does.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CryptoError } from '@chittu/db';
import { resolveKeys } from './index.js';
import type { KmsApi } from './kms.js';

const ARN = 'arn:aws:kms:ap-south-1:111122223333:key/abcd-1234';
const b64 = (n: number) => randomBytes(n).toString('base64');

const noKms = (): KmsApi => ({
  async generateDataKey() { throw new Error('should not be called'); },
  async decrypt() { throw new Error('should not be called'); },
});

describe('resolveKeys', () => {
  /**
   * The production image sets NODE_ENV=production and the ECS task definition
   * injects no key configuration. Booting like that used to yield a local
   * provider with an EPHEMERAL master key — a different one per task, discarded
   * on restart. It must refuse instead.
   */
  it('refuses to boot in production with no KMS configuration', () => {
    expect(() => resolveKeys({ NODE_ENV: 'production' }, noKms)).toThrow(CryptoError);
  });

  it('names the variable that would fix it', () => {
    expect(() => resolveKeys({ NODE_ENV: 'production' }, noKms))
      .toThrow(/CHITTU_KMS_KEY_ARN/);
  });

  it('uses a local provider outside production', async () => {
    const keys = resolveKeys({ NODE_ENV: 'development' }, noKms);
    const dek = await keys.generateDek();
    expect(dek.keyRef).toBe('local:dev-master');
  });

  it('uses KMS when a CMK is configured', async () => {
    const keys = resolveKeys(
      { NODE_ENV: 'production', CHITTU_KMS_KEY_ARN: ARN, CHITTU_INDEX_KEY: b64(32) },
      () => ({
        async generateDataKey() {
          return { plaintext: randomBytes(32), ciphertext: Buffer.from('wrapped') };
        },
        async decrypt() { return randomBytes(32); },
      }),
    );
    expect((await keys.generateDek()).keyRef).toBe(ARN);
  });

  it('refuses a CMK with no index key — the blind index would be unstable', () => {
    expect(() => resolveKeys({ CHITTU_KMS_KEY_ARN: ARN }, noKms))
      .toThrow(/CHITTU_INDEX_KEY/);
  });

  it('refuses an index key that is not 32 bytes once decoded', () => {
    expect(() => resolveKeys(
      { CHITTU_KMS_KEY_ARN: ARN, CHITTU_INDEX_KEY: b64(16) }, noKms,
    )).toThrow(CryptoError);
  });

  it('refuses an index key that is not valid base64', () => {
    expect(() => resolveKeys(
      { CHITTU_KMS_KEY_ARN: ARN, CHITTU_INDEX_KEY: 'not base64 !!!' }, noKms,
    )).toThrow(CryptoError);
  });

  /**
   * Dev is allowed to opt IN to KMS — staging-shaped rehearsal on a laptop —
   * so the branch must key off the CMK being present, not off NODE_ENV.
   */
  it('uses KMS outside production too, when configured', async () => {
    const keys = resolveKeys(
      { NODE_ENV: 'development', CHITTU_KMS_KEY_ARN: ARN, CHITTU_INDEX_KEY: b64(32) },
      () => ({
        async generateDataKey() {
          return { plaintext: randomBytes(32), ciphertext: Buffer.from('w') };
        },
        async decrypt() { return randomBytes(32); },
      }),
    );
    expect((await keys.generateDek()).keyRef).toBe(ARN);
  });
});
