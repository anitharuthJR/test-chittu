/**
 * Envelope encryption, and the crypto-shred that makes "we erased it" honest.
 *
 * Every child gets a data key (DEK). Column values are AES-256-GCM under that
 * DEK; the DEK itself is stored wrapped, never in plaintext. Deleting the wrapped
 * DEK makes every ciphertext for that child unrecoverable in one statement —
 * including in backups taken yesterday, which is the part row deletion cannot do.
 *
 * We do NOT use pgcrypto for this. Passing a key as a SQL argument puts it in
 * query logs and in `pg_stat_statements`, so the plaintext key would end up
 * exactly where the ciphertext is.
 */

import {
  createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual,
} from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;    // GCM standard
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Where data keys come from. AWS KMS in production; `localKeyProvider` in dev
 * and test. The port exists so that swapping to KMS is a construction change
 * rather than a rewrite of everything that encrypts.
 */
export interface KeyProvider {
  /** A fresh DEK, plus the form we store. */
  generateDek(): Promise<{ plaintext: Buffer; wrapped: Buffer; keyRef: string }>;
  unwrap(wrapped: Buffer, keyRef: string): Promise<Buffer>;
  /** Deterministic key for blind-index HMACs — see `fingerprint`. */
  indexKey(): Promise<Buffer>;
}

export class CryptoError extends Error {
  constructor(message: string) { super(message); this.name = 'CryptoError'; }
}

// ---------------------------------------------------------------------------

/** `iv || tag || ciphertext`, so a value is one self-contained bytea. */
export function encrypt(plaintext: string, dek: Buffer): Buffer {
  if (dek.length !== KEY_LEN) throw new CryptoError('DEK must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, dek, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, dek: Buffer): string {
  if (dek.length !== KEY_LEN) throw new CryptoError('DEK must be 32 bytes');
  if (blob.length < IV_LEN + TAG_LEN) throw new CryptoError('ciphertext too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = blob.subarray(IV_LEN + TAG_LEN);
  const d = createDecipheriv(ALG, dek, iv);
  d.setAuthTag(tag);
  // GCM's tag check throws here on any tampering, which is the point: an
  // altered ciphertext fails loudly rather than decrypting to nonsense.
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/**
 * Keyed blind index — lets us look up or de-duplicate without decrypting.
 *
 * Used for `parent.email_hash` (login) and `memory.fact_fingerprint` (the
 * "already remembered this" check). It must be KEYED: a bare SHA of an email is
 * trivially reversible from a wordlist, which would make the column a plaintext
 * email in all but name.
 */
export function fingerprint(value: string, indexKey: Buffer): Buffer {
  return createHmac('sha256', indexKey).update(value.trim().toLowerCase(), 'utf8').digest();
}

export function fingerprintEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Local provider
// ---------------------------------------------------------------------------

/**
 * Development and test only. The master key lives in the process instead of a
 * KMS, so an attacker with the database ALSO needs the process — which is a much
 * weaker separation than KMS gives, and the reason this refuses to run in
 * production.
 */
export function localKeyProvider(masterKey: Buffer, env: string = 'dev'): KeyProvider {
  if (env === 'prod') {
    throw new CryptoError(
      'localKeyProvider is not permitted in production — wire a KMS-backed provider',
    );
  }
  if (masterKey.length !== KEY_LEN) throw new CryptoError('master key must be 32 bytes');
  return {
    async generateDek() {
      const plaintext = randomBytes(KEY_LEN);
      return {
        plaintext,
        wrapped: encrypt(plaintext.toString('base64'), masterKey),
        keyRef: 'local:dev-master',
      };
    },
    async unwrap(wrapped) {
      if (wrapped.length === 0) {
        // A zeroed DEK is a shredded child, not a corrupt row. Say which.
        throw new CryptoError('data key has been shredded — this child was erased');
      }
      return Buffer.from(decrypt(wrapped, masterKey), 'base64');
    },
    async indexKey() {
      // Derived from the master key so it rotates with it, and distinct from it
      // so a blind index can never be mistaken for an encryption key.
      return createHmac('sha256', masterKey).update('chittu:blind-index:v1').digest();
    },
  };
}

/** Read the dev master key from the environment, or make an ephemeral one. */
export function devMasterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['CHITTU_DEV_MASTER_KEY'];
  if (raw) {
    const b = Buffer.from(raw, 'base64');
    if (b.length !== KEY_LEN) {
      throw new CryptoError('CHITTU_DEV_MASTER_KEY must be 32 bytes, base64-encoded');
    }
    return b;
  }
  // Ephemeral: everything encrypted in this process becomes unreadable when it
  // exits. Correct for tests, and a loud failure mode for anyone who tries to
  // keep data across a restart without setting a key.
  return randomBytes(KEY_LEN);
}
