/**
 * The seal chain, persisted.
 *
 * CLAUDE.md: "Audit chain writes are serialized (`auditQueue`) so the hash chain
 * can never fork." In the prototype that queue was a promise chain inside one
 * browser tab. Behind an API with several processes, a promise chain guarantees
 * nothing — two API tasks can compute the same `prev` at the same instant and
 * write two records claiming the same position.
 *
 * So serialisation moves to where it can still hold: a row lock on the session,
 * taken inside the same transaction as the insert. `UNIQUE(session_id, seq)` is
 * the backstop underneath it — if the lock were ever dropped, the second writer
 * gets a constraint violation rather than a forked chain.
 */

import { createHash } from 'node:crypto';
import type { Db, DbPool } from './client';

export const GENESIS = 'GENESIS';

export interface AuditAppend {
  readonly sessionId: string;
  readonly role: 'child' | 'chittu' | 'system';
  readonly layer: string;
  /** The content being sealed. This — and only this — enters the hash. */
  readonly text: string;
}

export interface AuditRecord {
  readonly seq: number;
  readonly role: string;
  readonly layer: string;
  readonly payloadHash: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly ts: string;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * `payloadHash = sha(role|text)` and `hash = sha(prev|payloadHash)`.
 *
 * A DELIBERATE CHANGE from the prototype, forced by the schema and worth
 * keeping. The prototype held the payload in memory and hashed `prev|payload`
 * directly. `audit_event` stores only `payload_hash` and never the payload —
 * because the payload is what the child said, and an audit table full of
 * children's words is the treasure that should not exist.
 *
 * Composing hashes instead means the chain is verifiable from what is stored,
 * with no content at rest. Had the prototype's form been ported literally,
 * `verify()` could not recompute anything and would only ever have been able to
 * check the links — a verification that verifies nothing.
 *
 * `layer` and `ts` remain outside the hash, matching the prototype. Widening
 * that is a decision, not a refactor — see PORT-REVIEW.md §5.
 */
export function chainHash(prevHash: string, role: string, text: string): {
  payloadHash: string; hash: string;
} {
  const payloadHash = sha(`${role}|${text}`);
  return { payloadHash, hash: sha(`${prevHash}|${payloadHash}`) };
}

export function auditRepo(pool: DbPool) {
  return {
    /**
     * Append one event. Must be called inside a transaction that already holds
     * the child scope; `tx` is passed rather than taken from the pool so a
     * turn's seal and its state change commit together or not at all.
     */
    async append(tx: Db, e: AuditAppend): Promise<AuditRecord> {
      // Serialise per session. Every appender for this session queues here, so
      // no two can read the same head.
      await tx.query('SELECT id FROM session WHERE id = $1 FOR UPDATE', [e.sessionId]);

      const head = await tx.query<{ seq: number; hash: string }>(
        `SELECT seq, hash FROM audit_event
          WHERE session_id = $1 ORDER BY seq DESC LIMIT 1`, [e.sessionId]);

      const prevHash = head.rows[0]?.hash ?? GENESIS;
      const seq = head.rows[0] ? head.rows[0].seq + 1 : 0;
      const { payloadHash, hash } = chainHash(prevHash, e.role, e.text);

      const ins = await tx.query<{ ts: string }>(
        `INSERT INTO audit_event (session_id, seq, role, layer, payload_hash, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ts`,
        [e.sessionId, seq, e.role, e.layer, payloadHash, prevHash, hash]);

      return {
        seq, role: e.role, layer: e.layer, payloadHash, prevHash, hash,
        ts: String(ins.rows[0]?.ts ?? ''),
      };
    },

    /**
     * Recompute from GENESIS — the parent-facing "nothing was edited" check.
     * Verifies the LINK as well as the hash: a record whose `prev_hash` alone was
     * edited passes a hash-only check, which is the gap PORT-REVIEW.md §5 records
     * in the prototype. Here it does not.
     */
    async verify(sessionId: string): Promise<{
      ok: boolean; records: number; brokenAt: number | null;
    }> {
      const r = await pool.query<{
        seq: number; role: string; payload_hash: string; prev_hash: string; hash: string;
      }>(`SELECT seq, role, payload_hash, prev_hash, hash FROM audit_event
           WHERE session_id = $1 ORDER BY seq ASC`, [sessionId]);

      let prev = GENESIS;
      for (const [i, row] of r.rows.entries()) {
        if (row.seq !== i) return { ok: false, records: r.rows.length, brokenAt: i };
        if (row.prev_hash !== prev) {
          return { ok: false, records: r.rows.length, brokenAt: row.seq };
        }
        if (sha(`${prev}|${row.payload_hash}`) !== row.hash) {
          return { ok: false, records: r.rows.length, brokenAt: row.seq };
        }
        prev = row.hash;
      }
      return { ok: true, records: r.rows.length, brokenAt: null };
    },

    async head(sessionId: string): Promise<string> {
      const r = await pool.query<{ hash: string }>(
        `SELECT hash FROM audit_event WHERE session_id = $1 ORDER BY seq DESC LIMIT 1`,
        [sessionId]);
      return r.rows[0]?.hash ?? GENESIS;
    },

    async size(sessionId: string): Promise<number> {
      const r = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event WHERE session_id = $1`, [sessionId]);
      return r.rows[0]?.n ?? 0;
    },
  };
}

export type AuditRepo = ReturnType<typeof auditRepo>;
