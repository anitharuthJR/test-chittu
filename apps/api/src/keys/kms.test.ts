/**
 * The KMS-backed KeyProvider.
 *
 * Exercised against a fake `KmsApi` rather than the AWS SDK: the port exists so
 * that the interesting behaviour — what happens to a SHREDDED child, which key
 * a decrypt is pinned to, whether the index key is stable — is testable without
 * an account, exactly as `anthropicAdapter` takes an injectable `fetchImpl`.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fingerprint, CryptoError } from '@chittu/db';
import { kmsKeyProvider, type KmsApi } from './kms.js';

const ARN = 'arn:aws:kms:ap-south-1:111122223333:key/abcd-1234';

/** Records what it was asked, and wraps by prefixing so unwrap is checkable. */
function fakeKms() {
  const calls: Array<{ op: string; keyArn: string }> = [];
  const api: KmsApi = {
    async generateDataKey(keyArn) {
      calls.push({ op: 'generateDataKey', keyArn });
      const plaintext = randomBytes(32);
      return { plaintext, ciphertext: Buffer.concat([Buffer.from('wrapped:'), plaintext]) };
    },
    async decrypt(keyArn, ciphertext) {
      calls.push({ op: 'decrypt', keyArn });
      return Buffer.from(ciphertext.subarray('wrapped:'.length));
    },
  };
  return { api, calls };
}

const provider = (indexKey = randomBytes(32)) => {
  const { api, calls } = fakeKms();
  return { keys: kmsKeyProvider({ keyArn: ARN, indexKey, kms: api }), calls };
};

describe('kmsKeyProvider', () => {
  it('generates a DEK and reports the CMK as the key reference', async () => {
    const { keys } = provider();
    const dek = await keys.generateDek();
    expect(dek.plaintext).toHaveLength(32);
    expect(dek.wrapped.length).toBeGreaterThan(0);
    // child_data_key.kms_key_arn holds this, and unwrap() gets it back.
    expect(dek.keyRef).toBe(ARN);
  });

  it('round-trips a wrapped DEK', async () => {
    const { keys } = provider();
    const dek = await keys.generateDek();
    expect((await keys.unwrap(dek.wrapped, dek.keyRef)).equals(dek.plaintext)).toBe(true);
  });

  it('pins the decrypt to the key reference rather than letting KMS infer it', async () => {
    const { keys, calls } = provider();
    const dek = await keys.generateDek();
    await keys.unwrap(dek.wrapped, dek.keyRef);
    expect(calls).toEqual([
      { op: 'generateDataKey', keyArn: ARN },
      { op: 'decrypt', keyArn: ARN },
    ]);
  });

  /**
   * A shredded child is an ERASURE, not a KMS failure, and must read that way.
   * The check also has to sit ABOVE the call, or the operator sees
   * InvalidCiphertextException for a row we zeroed on purpose.
   */
  it('reports a shredded DEK as an erasure, without calling KMS', async () => {
    const { keys, calls } = provider();
    await expect(keys.unwrap(Buffer.alloc(0), ARN)).rejects.toThrow(/shredded/i);
    expect(calls).toEqual([]);
  });

  it('refuses a key reference written by the local provider', async () => {
    const { keys, calls } = provider();
    await expect(keys.unwrap(Buffer.from('x'), 'local:dev-master'))
      .rejects.toThrow(/local:dev-master/);
    expect(calls).toEqual([]);
  });

  it('rejects an index key that is not 32 bytes', () => {
    const { api } = fakeKms();
    expect(() => kmsKeyProvider({ keyArn: ARN, indexKey: randomBytes(16), kms: api }))
      .toThrow(CryptoError);
  });

  /**
   * THE INVARIANT THE EPHEMERAL KEY DESTROYED.
   *
   * Two tasks are two processes. If their index keys differ, the same parent
   * email fingerprints to two different values and a login that lands on the
   * other task finds nobody. Same injected key must mean same bytes, always.
   */
  it('fingerprints identically across independently constructed providers', async () => {
    const shared = randomBytes(32);
    const a = kmsKeyProvider({ keyArn: ARN, indexKey: shared, kms: fakeKms().api });
    const b = kmsKeyProvider({ keyArn: ARN, indexKey: shared, kms: fakeKms().api });
    const email = 'lakshmi@example.com';
    const fa = fingerprint(email, await a.indexKey());
    const fb = fingerprint(email, await b.indexKey());
    expect(fa.equals(fb)).toBe(true);
  });

  it('does not share an index key between different deployments', async () => {
    const a = kmsKeyProvider({ keyArn: ARN, indexKey: randomBytes(32), kms: fakeKms().api });
    const b = kmsKeyProvider({ keyArn: ARN, indexKey: randomBytes(32), kms: fakeKms().api });
    const email = 'lakshmi@example.com';
    expect(fingerprint(email, await a.indexKey())
      .equals(fingerprint(email, await b.indexKey()))).toBe(false);
  });
});
