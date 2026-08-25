/**
 * The consent ledger, persisted.
 *
 * Reads take a `Db` rather than closing over the pool. That is not ceremony:
 * a repository that reads from the pool while its caller holds a transaction
 * takes a SECOND connection — which on a single-connection driver deadlocks, and
 * on a real pool silently reads a different snapshot than the one being written.
 * Passing the handle makes "which transaction is this in?" impossible to fudge.
 *
 * Everything a child has exists downstream of a row here, so this file is the
 * one to read when asking "could a session exist without consent?". The answer
 * is enforced in three places that must all agree: `assertActiveConsent` in
 * @chittu/consent, `findByToken` here, and `token_only_when_active` in the
 * database.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Band, Country } from '@chittu/contracts';
import type {
  ConsentMethod, ConsentRecord, ConsentScope, VerificationEvidence,
} from '@chittu/consent';
import type { Db, DbPool } from './client.js';
import { fromJurisdiction, toJurisdiction, type Jurisdiction } from './jurisdiction.js';
import { encrypt, fingerprint, type KeyProvider } from './crypto.js';

export interface FamilyDraft {
  readonly parentName: string;
  /**
   * Required, and not in the prototype's flow — which collected a parent's name
   * and no way to reach them. DPDP gives 72 hours to notify affected users of a
   * breach and CERT-In gives 6; neither is achievable without an address. It is
   * the only adult PII we hold, encrypted, with a keyed blind index for lookup.
   */
  readonly parentEmail: string;
  readonly childFirstName: string;
  readonly country: Country;
  readonly band: Band;
  readonly board: string;
  readonly memoryOn: boolean;
  readonly learnOn: boolean;
  /** A camera and a microphone are separate asks. Default-deny at every caller. */
  readonly visionOn: boolean;
  readonly voiceOn: boolean;
}

export interface StoredConsent {
  readonly consentId: string;
  readonly childId: string;
  readonly parentId: string;
  readonly record: ConsentRecord;
  /**
   * Name-match attempts already spent on the automated ID rail.
   *
   * Read from the row rather than taken from the request, because an attempt
   * count the caller supplies is not a bound at all — and this one exists to
   * stop a stolen session being used to guess the name on somebody's ID.
   */
  readonly verifyAttempts: number;
}

/** Tokens are compared by hash, and the hash is keyed — see migration 0002. */
function tokenHash(token: string, indexKey: Buffer): Buffer {
  return fingerprint(token, indexKey);
}

function rowToRecord(r: ConsentRow, childFirstName: string): ConsentRecord {
  return {
    id: r.id,
    version: r.version,
    supersedes: r.supersedes,
    childFirstName,
    band: r.band,
    board: r.board,
    // Both fields carry the ISO spelling. `jurisdiction` is in `canonicalise`
    // and therefore in the seal hash, so handing back the column's spelling
    // would break the ledger check for every British family.
    country: fromJurisdiction(r.jurisdiction),
    jurisdiction: fromJurisdiction(r.jurisdiction),
    law: r.law,
    method: r.method,
    status: r.status,
    scopes: r.scopes as ConsentScope[],
    memoryOn: r.memory_on,
    learnOn: r.learn_on,
    issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    revokeReason: r.revoke_reason,
    sealHash: r.seal_hash,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

interface ConsentRow {
  id: string; version: number; supersedes: string | null;
  /**
   * The COLUMN's vocabulary, not the domain's. Declared `Country` until
   * 2026-08-25, which is what let `rowToRecord` hand `'UK'` out as a `Country`
   * and still compile. Typed honestly, nothing can reach a `Country` field
   * without `fromJurisdiction`.
   */
  jurisdiction: Jurisdiction; law: string; method: ConsentMethod;
  status: ConsentRecord['status']; scopes: unknown;
  memory_on: boolean; learn_on: boolean; band: Band; board: string;
  issued_at: string | null; expires_at: string | null;
  revoked_at: string | null; revoke_reason: string | null;
  seal_hash: string; created_at: string; verify_attempts: number;
}

export function consentRepo(pool: DbPool, keys: KeyProvider) {
  return {
    /**
     * Creates the whole family in ONE transaction: parent, child, the child's
     * data key, the PIN, and a consent in `verifying`.
     *
     * All of it or none of it. A half-created family — a child row with no data
     * key, say — would be a child whose data cannot be encrypted and cannot be
     * shredded, which is worse than no child at all.
     */
    async createDraft(
      draft: FamilyDraft,
      method: ConsentMethod,
      law: string,
      pinHash: string,
      record: ConsentRecord,
    ): Promise<StoredConsent> {
      const indexKey = await keys.indexKey();
      const dek = await keys.generateDek();
      const masterEmailKey = indexKey;

      return pool.transaction(async (tx) => {
        const p = await tx.query<{ id: string }>(
          `INSERT INTO parent (email_hash, email_enc, display_name_enc)
           VALUES ($1, $2, $3)
           ON CONFLICT (email_hash) DO UPDATE SET locale = parent.locale
           RETURNING id`,
          [
            fingerprint(draft.parentEmail, masterEmailKey),
            encrypt(draft.parentEmail, dek.plaintext),
            encrypt(draft.parentName, dek.plaintext),
          ]);
        const parentId = p.rows[0]!.id;

        /**
         * DO NOTHING, and this line is a security control.
         *
         * It used to be `DO UPDATE SET pin_hash = EXCLUDED.pin_hash,
         * failed_attempts = 0, locked_until = NULL` — an UNVERIFIED draft
         * overwrote an existing family's parent PIN. `/v1/consent/draft` takes
         * no credential and completes no challenge, so the whole attack was:
         * know the parent's email, POST a draft, choose the PIN.
         *
         * The child is the one who knows that email, and the child is holding
         * the device the consent cookie is on. `/v1/parent/pin/verify` checks
         * the PIN of whichever parent that cookie resolves to, so the child
         * then entered their own new PIN, got a `chittu_parent` cookie, and
         * with it could lift a crisis lock and erase the account — the two
         * things cookies.ts says "only a correct PIN mints". The real parent's
         * PIN meanwhile stopped working. Verified end to end before the fix:
         * new PIN 200, original PIN 401, on the original cookie.
         *
         * So a returning parent keeps the PIN they already have. Enrolling a
         * second child does not change it, and there is deliberately no path
         * here that can: rotating a PIN is a thing that must prove it is the
         * parent, which means a route behind the parent session, not a field on
         * an anonymous form.
         */
        await tx.query(
          `INSERT INTO parent_pin (parent_id, pin_hash) VALUES ($1, $2)
           ON CONFLICT (parent_id) DO NOTHING`,
          [parentId, pinHash]);

        const c = await tx.query<{ id: string }>(
          `INSERT INTO child (parent_id, first_name_enc, band, board, country)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [parentId, encrypt(draft.childFirstName, dek.plaintext),
           draft.band, draft.board, toJurisdiction(draft.country)]);
        const childId = c.rows[0]!.id;

        await tx.query(
          `INSERT INTO child_data_key (child_id, wrapped_dek, kms_key_arn)
           VALUES ($1, $2, $3)`,
          [childId, dek.wrapped, dek.keyRef]);

        const cr = await tx.query<{ id: string }>(
          `INSERT INTO consent_record
             (id, parent_id, child_id, version, jurisdiction, law, method, status,
              scopes, memory_on, learn_on, band, board, seal_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [record.id, parentId, childId, record.version,
           toJurisdiction(record.jurisdiction), law,
           method, record.status, JSON.stringify(record.scopes), record.memoryOn,
           record.learnOn, record.band, record.board, record.sealHash]);

        return { consentId: cr.rows[0]!.id, childId, parentId, record, verifyAttempts: 0 };
      });
    },

    /**
     * Verification succeeded. Writes the evidence REFERENCE (never the document),
     * flips the record to active, and issues the bearer token — in one
     * transaction, because a token on a non-active consent is exactly what
     * `token_only_when_active` exists to make impossible.
     */
    async activate(
      consentId: string,
      evidence: VerificationEvidence,
      activated: ConsentRecord,
    ): Promise<{ token: string }> {
      const token = randomBytes(32).toString('base64url');
      const indexKey = await keys.indexKey();
      await pool.transaction(async (tx) => {
        await tx.query(
          `UPDATE consent_record
              SET status = 'active', issued_at = $2, expires_at = $3,
                  seal_hash = $4, token_hash = $5, token_issued_at = now()
            WHERE id = $1 AND status = 'verifying'`,
          [consentId, activated.issuedAt, activated.expiresAt, activated.sealHash,
           tokenHash(token, indexKey)]);
        await tx.query(
          `INSERT INTO consent_verification
             (consent_id, method, provider, provider_ref, evidence_hash, verified_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [consentId, evidence.method, evidence.provider, evidence.providerRef,
           Buffer.from(evidence.evidenceHash, 'hex'), evidence.verifiedAt,
           evidence.expiresAt ?? null]);
      });
      return { token };
    },

    /**
     * THE GATE, database half. Only an ACTIVE consent can carry a token, so a
     * revoked or superseded one cannot be found here even if the caller still
     * holds the string.
     */
    async findByToken(db: Db, token: string): Promise<StoredConsent | null> {
      const indexKey = await keys.indexKey();
      const r = await db.query<ConsentRow & { child_id: string; parent_id: string }>(
        `SELECT c.*, c.child_id, c.parent_id FROM consent_record c
          WHERE c.token_hash = $1 AND c.status = 'active'`,
        [tokenHash(token, indexKey)]);
      const row = r.rows[0];
      if (!row) return null;
      const name = await this.childName(db, row.child_id);
      return {
        consentId: row.id, childId: row.child_id, parentId: row.parent_id,
        record: rowToRecord(row, name),
        verifyAttempts: row.verify_attempts ?? 0,
      };
    },

    async byId(db: Db, consentId: string): Promise<StoredConsent | null> {
      const r = await db.query<ConsentRow & { child_id: string; parent_id: string }>(
        `SELECT c.*, c.child_id, c.parent_id FROM consent_record c WHERE c.id = $1`,
        [consentId]);
      const row = r.rows[0];
      if (!row) return null;
      // The name is encrypted under the child's DEK, and revocation shreds it.
      // The LEDGER must outlive the data it consented to — that is the whole
      // point of keeping the row — so a shredded name yields '' rather than
      // making the record unreadable.
      let name = '';
      try { name = await this.childName(db, row.child_id); } catch { name = ''; }
      return {
        consentId: row.id, childId: row.child_id, parentId: row.parent_id,
        record: rowToRecord(row, name),
        verifyAttempts: row.verify_attempts ?? 0,
      };
    },

    /**
     * Record one spent name-match attempt and return the new total.
     *
     * Capped in SQL as well as in the adapter: `verify_attempts_sane` refuses a
     * fourth, so a caller that forgets to check the bound hits the database's
     * refusal rather than looping forever. `LEAST` keeps the UPDATE itself from
     * being the thing that violates the constraint.
     */
    async noteVerifyAttempt(consentId: string): Promise<number> {
      const r = await pool.query<{ verify_attempts: number }>(
        `UPDATE consent_record
            SET verify_attempts = LEAST(verify_attempts + 1, 3)
          WHERE id = $1 AND status = 'verifying'
        RETURNING verify_attempts`,
        [consentId]);
      return r.rows[0]?.verify_attempts ?? 0;
    },

    /** Decrypts the child's first name. Needs the child's own DEK. */
    async childName(db: Db, childId: string): Promise<string> {
      const r = await db.query<{ first_name_enc: Buffer; wrapped_dek: Buffer; kms_key_arn: string }>(
        `SELECT ch.first_name_enc, k.wrapped_dek, k.kms_key_arn
           FROM child ch JOIN child_data_key k ON k.child_id = ch.id
          WHERE ch.id = $1`, [childId]);
      const row = r.rows[0];
      if (!row) return '';
      const { decrypt } = await import('./crypto.js');
      const dek = await keys.unwrap(toBuffer(row.wrapped_dek), row.kms_key_arn);
      return decrypt(toBuffer(row.first_name_enc), dek);
    },

    /**
     * Revoke and erase (schema §12). Calls the database function, which shreds
     * the data key, drops messages, closes sessions and leaves the ledger row
     * standing as proof — inside the child scope, because that function now
     * refuses an unscoped call rather than silently erasing nothing.
     */
    async revokeAndErase(consentId: string, childId: string, reason: string): Promise<void> {
      await pool.transaction(async (tx) => {
        await tx.query('SELECT set_config($1, $2, true)', ['chittu.child_id', childId]);
        // clear the token first: token_only_when_active would reject the status
        // change while a token is still attached
        await tx.query(
          `UPDATE consent_record SET token_hash = NULL, token_issued_at = NULL
            WHERE id = $1`, [consentId]);
        await tx.query('SELECT revoke_and_erase($1, $2)', [childId, reason]);
      });
    },

    // ---- PIN ------------------------------------------------------------

    async pinFor(db: Db, parentId: string): Promise<{
      hash: string; failedAttempts: number; lockedUntil: number | null;
    } | null> {
      const r = await db.query<{
        pin_hash: string; failed_attempts: number; locked_until: string | null;
      }>(`SELECT pin_hash, failed_attempts, locked_until FROM parent_pin WHERE parent_id = $1`,
        [parentId]);
      const row = r.rows[0];
      if (!row) return null;
      return {
        hash: row.pin_hash,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until ? new Date(row.locked_until).getTime() : null,
      };
    },

    /** Durable, so flushing a cache cannot reset a lockout Postgres remembers. */
    async savePinState(
      parentId: string, failedAttempts: number, lockedUntil: number | null,
    ): Promise<void> {
      await pool.query(
        `UPDATE parent_pin SET failed_attempts = $2, locked_until = $3 WHERE parent_id = $1`,
        [parentId, failedAttempts, lockedUntil ? new Date(lockedUntil).toISOString() : null]);
    },
  };
}

/**
 * Defensive, not required: node-postgres hands back Buffer for bytea. It kept a
 * second driver honest (PGlite returned Uint8Array) and is retained because this
 * feeds the PIN comparison — a normalise here is cheaper than the class of bug
 * that appears if a driver ever disagrees again.
 */
export function toBuffer(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

export type ConsentRepo = ReturnType<typeof consentRepo>;

/** Exported for tests that need to assert a token is not stored in the clear. */
export function tokenDigestForTest(token: string, indexKey: Buffer): Buffer {
  return tokenHash(token, indexKey);
}

export const _internal = { createHash, timingSafeEqual };
