/**
 * The KMS-backed KeyProvider — envelope encryption where the master key is a
 * CMK the application can USE and never READ.
 *
 * `localKeyProvider` keeps the master key in the process, so anyone who reaches
 * the process reaches every child's data. Here the wrapping key never leaves
 * KMS: compromise of a task yields the ability to ask KMS to decrypt while the
 * task lives, and nothing at all afterwards. That difference is why
 * `localKeyProvider` refuses to run outside dev.
 *
 * WHY A NARROW PORT rather than the AWS SDK client directly: the behaviour worth
 * testing is what happens to a SHREDDED child, which key a decrypt is pinned to,
 * and whether the index key is stable across processes. None of that needs an
 * AWS account, and `@aws-sdk/client-kms` dispatches on command CLASSES, so a
 * fake would be `instanceof` plumbing. `anthropicAdapter` takes an injectable
 * `fetchImpl` for the same reason.
 */
import { CryptoError, type KeyProvider } from '@chittu/db';

const KEY_LEN = 32;

/** The two KMS operations this system performs, and no others. */
export interface KmsApi {
  /** A fresh 256-bit data key: the plaintext to use, the ciphertext to store. */
  generateDataKey(keyArn: string): Promise<{ plaintext: Buffer; ciphertext: Buffer }>;
  decrypt(keyArn: string, ciphertext: Buffer): Promise<Buffer>;
}

export interface KmsKeyProviderOptions {
  /** The child-data CMK. Stored per child in `child_data_key.kms_key_arn`. */
  readonly keyArn: string;
  /**
   * The blind-index key — 32 bytes, IDENTICAL in every task, forever.
   *
   * KMS has no "give me the same key bytes twice" operation, so this is resolved
   * from Secrets Manager at boot rather than derived. It must not be generated:
   * a per-task index key makes `parent.email_hash` unmatchable from any other
   * task, which reads as "login is broken" and is really "the key moved".
   */
  readonly indexKey: Buffer;
  readonly kms: KmsApi;
}

export function kmsKeyProvider(opts: KmsKeyProviderOptions): KeyProvider {
  const { keyArn, indexKey, kms } = opts;
  if (indexKey.length !== KEY_LEN) {
    throw new CryptoError(
      `index key must be ${KEY_LEN} bytes, got ${indexKey.length} — a truncated `
      + `blind-index key silently changes every fingerprint`,
    );
  }
  if (keyArn === '') throw new CryptoError('kmsKeyProvider needs a CMK ARN');

  return {
    async generateDek() {
      const { plaintext, ciphertext } = await kms.generateDataKey(keyArn);
      if (plaintext.length !== KEY_LEN) {
        throw new CryptoError(`KMS returned a ${plaintext.length}-byte data key`);
      }
      return { plaintext, wrapped: ciphertext, keyRef: keyArn };
    },

    async unwrap(wrapped, keyRef) {
      // ABOVE the KMS call, deliberately. A zeroed DEK is a child we erased on
      // purpose; sending it to KMS would turn a correct answer into
      // InvalidCiphertextException and send someone hunting a key problem.
      if (wrapped.length === 0) {
        throw new CryptoError('data key has been shredded — this child was erased');
      }
      // Rows written by localKeyProvider carry `local:dev-master`. Handing that
      // to KMS is a confusing failure; saying so is a clear one.
      if (!keyRef.startsWith('arn:')) {
        throw new CryptoError(
          `key reference ${JSON.stringify(keyRef)} was not written by KMS — this `
          + `row predates the KMS provider and cannot be read by it`,
        );
      }
      // keyRef, not "whatever the blob says": passing the key id makes KMS
      // VERIFY rather than infer, so a swapped ciphertext fails instead of
      // decrypting under some other key the task can also reach.
      const dek = await kms.decrypt(keyRef, wrapped);
      if (dek.length !== KEY_LEN) {
        throw new CryptoError(`KMS returned a ${dek.length}-byte data key`);
      }
      return dek;
    },

    async indexKey() {
      return indexKey;
    },
  };
}
