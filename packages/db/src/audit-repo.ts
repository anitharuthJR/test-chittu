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
import type { Db, DbPool } from './client.js';

export const GENESIS = 'GENESIS';

/**
 * Each session's chain starts from its OWN genesis.
 *
 * A plain shared 'GENESIS' looks harmless and is not: two sessions whose first
 * turn is the same text produce the same payload hash from the same previous
 * hash, so they produce the SAME record hash — and `UNIQUE (hash)` rejects the
 * second one. Two children asking "why is the sky blue" first is not an edge
 * case; it is Tuesday.
 *
 * Binding the session into the genesis also means a record cannot be lifted from
 * one child's chain and dropped into another's: it would no longer verify.
 */
export function genesisFor(sessionId: string): string {
  return `${GENESIS}|${sessionId}`;
}

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

      const prevHash = head.rows[0]?.hash ?? genesisFor(e.sessionId);
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

      let prev = genesisFor(sessionId);
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

    /**
     * D5/SEAL — "recompute every hash", over EVERY chain the child has.
     *
     * `verify(sessionId)` answers for one conversation. A parent asking whether
     * anything was edited is not asking about one conversation, and the
     * prototype's button recomputed the lot from GENESIS. Per session that is
     * still what happens: each chain is seeded from its own `genesisFor`, so
     * this is a loop over chains rather than one longer chain.
     *
     * The rows come back ordered by session and then by seq, so the walk is a
     * single pass. `broken` names WHICH conversation as well as which record —
     * a parent told "record 3 is wrong" with no session is told nothing.
     *
     * Reads from `pool`, like `verify`, and must be called OUTSIDE a
     * `withChild` transaction. Taking a second handle inside one is how this
     * repo has twice ended up reading outside the child scope.
     */
    async verifyChild(childId: string): Promise<{
      ok: boolean;
      /** Chains examined. */
      sessions: number;
      /** Hashes recomputed. */
      records: number;
      broken: { sessionId: string; seq: number } | null;
    }> {
      const r = await pool.query<{
        session_id: string; seq: number; payload_hash: string;
        prev_hash: string; hash: string;
      }>(`SELECT a.session_id, a.seq, a.payload_hash, a.prev_hash, a.hash
            FROM audit_event a JOIN session s ON s.id = a.session_id
           WHERE s.child_id = $1
           ORDER BY a.session_id ASC, a.seq ASC`, [childId]);

      const seen = new Set<string>();
      let prev = '';
      let expectedSeq = 0;
      let broken: { sessionId: string; seq: number } | null = null;

      for (const row of r.rows) {
        if (!seen.has(row.session_id)) {
          seen.add(row.session_id);
          prev = genesisFor(row.session_id);
          expectedSeq = 0;
        }
        // Keep walking after a break rather than returning: `sessions` and
        // `records` are what the parent is told was examined, and a count that
        // stops at the first bad record understates the work every time.
        if (broken === null) {
          // Three checks, matching `verify()` clause for clause so the two
          // cannot answer differently about the same chain. The `seq` one is
          // belt-and-braces — every gap it would catch also breaks the prev
          // link — and it is kept because the per-session verify has it.
          //
          // NEITHER catches a chain TRUNCATED at the tail: what remains still
          // recomputes end to end. That is what `seal_anchor` is for (heads
          // published outside the database), and it is not populated yet.
          if (row.seq !== expectedSeq
            || row.prev_hash !== prev
            || sha(`${prev}|${row.payload_hash}`) !== row.hash) {
            broken = { sessionId: row.session_id, seq: row.seq };
          }
        }
        prev = row.hash;
        expectedSeq = row.seq + 1;
      }

      return {
        ok: broken === null, sessions: seen.size, records: r.rows.length, broken,
      };
    },

    async head(sessionId: string): Promise<string> {
      const r = await pool.query<{ hash: string }>(
        `SELECT hash FROM audit_event WHERE session_id = $1 ORDER BY seq DESC LIMIT 1`,
        [sessionId]);
      return r.rows[0]?.hash ?? genesisFor(sessionId);
    },

    async size(sessionId: string): Promise<number> {
      const r = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event WHERE session_id = $1`, [sessionId]);
      return r.rows[0]?.n ?? 0;
    },
  };
}

export type AuditRepo = ReturnType<typeof auditRepo>;
