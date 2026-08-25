/**
 * Where the key provider comes from, and the refusals that guard it.
 *
 * THIS IS DELIBERATELY NOT PART OF `bootstrapDb()`. Two reasons, and the second
 * is the load-bearing one:
 *
 * 1. Config first, connections second — the same ordering `main.ts` already
 *    applies to ANTHROPIC_API_KEY. A missing-key refusal that only surfaces
 *    after a database connection attempt gets shadowed by the database error.
 *
 * 2. `providers/cli.ts` and `helplines/cli.ts` call `bootstrapDb()` and use only
 *    `{ pool }` — they never touch keys. With key construction inside
 *    bootstrapDb, the fail-closed guard would make the HELPLINE SWEEP refuse to
 *    run in production over a key it does not use, and that sweep is the GAP-06
 *    P0 path (docs/runbooks/helpline-p0.md). Separating them keeps the guard
 *    strict without taking the crisis tooling down with it.
 */
import {
  localKeyProvider, devMasterKeyFromEnv, deploymentEnv, CryptoError,
  type KeyProvider,
} from '@chittu/db';
import { kmsKeyProvider, type KmsApi } from './kms.js';
import { kmsApiFromSdk } from './kms-sdk.js';

const KEY_LEN = 32;

export type KmsFactory = (region: string | undefined) => KmsApi;

/**
 * Decode the blind-index key, refusing anything that would silently change every
 * fingerprint. `Buffer.from(s, 'base64')` does not throw on rubbish — it drops
 * invalid characters and returns whatever it managed — so the length check is
 * the only thing standing between a typo and an unmatchable `parent.email_hash`.
 */
function readIndexKey(raw: string): Buffer {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new CryptoError(
      `CHITTU_INDEX_KEY must decode to ${KEY_LEN} bytes, got ${buf.length} — `
      + `generate one with: openssl rand -base64 32`,
    );
  }
  return buf;
}

export function resolveKeys(
  env: NodeJS.ProcessEnv = process.env,
  makeKms: KmsFactory = kmsApiFromSdk,
): KeyProvider {
  const keyArn = env['CHITTU_KMS_KEY_ARN'] ?? '';

  if (keyArn !== '') {
    // Keyed off the CMK rather than NODE_ENV on purpose: a laptop is allowed to
    // opt in to KMS to rehearse the production shape.
    const raw = env['CHITTU_INDEX_KEY'] ?? '';
    if (raw === '') {
      throw new CryptoError(
        'CHITTU_KMS_KEY_ARN is set but CHITTU_INDEX_KEY is not. KMS cannot '
        + 'reproduce the same key bytes twice, so the blind index would differ '
        + 'per task and no parent could be found by email from another task.',
      );
    }
    return kmsKeyProvider({
      keyArn,
      indexKey: readIndexKey(raw),
      kms: makeKms(env['AWS_REGION']),
    });
  }

  // No CMK. localKeyProvider is an allowlist and refuses anything but 'dev', so
  // this is where a production boot stops.
  try {
    return localKeyProvider(devMasterKeyFromEnv(env), deploymentEnv(env));
  } catch (e) {
    if (!(e instanceof CryptoError)) throw e;
    throw new CryptoError(
      `${e.message}. Set CHITTU_KMS_KEY_ARN (the child-data CMK) and `
      + `CHITTU_INDEX_KEY (32 bytes, base64) to use KMS.`,
    );
  }
}
