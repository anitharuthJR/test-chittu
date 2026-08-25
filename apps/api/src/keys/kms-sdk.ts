/**
 * The AWS SDK behind `KmsApi`, and nothing else.
 *
 * Kept to one file so the provider stays testable without an account, and so
 * that the SDK is the only thing here that would need swapping if this ever
 * runs somewhere other than AWS.
 *
 * STATICALLY IMPORTED ON PURPOSE, and it is worth 75ms on a dev boot that never
 * uses it. Deferring it behind a dynamic import would move the
 * failure from process start to the first child's turn, and "the SDK is missing
 * from this image" is a thing to learn while the task is still starting rather
 * than while a nine-year-old is waiting for a reply.
 */
import {
  KMSClient, GenerateDataKeyCommand, DecryptCommand,
} from '@aws-sdk/client-kms';
import { CryptoError } from '@chittu/db';
import type { KmsApi } from './kms.js';

export function kmsApiFromSdk(region: string | undefined): KmsApi {
  // No credentials here: the SDK's default chain picks up the ECS task role,
  // which is the only identity granted GenerateDataKey/Decrypt on the CMK.
  const client = new KMSClient(region === undefined ? {} : { region });

  return {
    async generateDataKey(keyArn) {
      const r = await client.send(new GenerateDataKeyCommand({
        KeyId: keyArn, KeySpec: 'AES_256',
      }));
      if (!r.Plaintext || !r.CiphertextBlob) {
        throw new CryptoError('KMS GenerateDataKey returned no key material');
      }
      return {
        plaintext: Buffer.from(r.Plaintext),
        ciphertext: Buffer.from(r.CiphertextBlob),
      };
    },

    async decrypt(keyArn, ciphertext) {
      // KeyId is passed so KMS VERIFIES the key rather than inferring it from
      // the blob — a ciphertext swapped for one under another key the task can
      // also reach then fails instead of decrypting.
      const r = await client.send(new DecryptCommand({
        KeyId: keyArn, CiphertextBlob: ciphertext,
      }));
      if (!r.Plaintext) throw new CryptoError('KMS Decrypt returned no plaintext');
      return Buffer.from(r.Plaintext);
    },
  };
}
