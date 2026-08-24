/**
 * @chittu/seal — the tamper-evident audit chain (the "seal chain").
 *
 * Ported from prototype/chittu-v3.html: `sha` and `auditAdd` (lines 794-802) plus
 * the parent dashboard's "Verify seal integrity" loop (lines 1208-1211). Every
 * byte that reaches the hash is preserved: the payload concatenation, the '|'
 * separators, the 'GENESIS' seed, and the 16-hex-char truncation. A chain sealed
 * by the prototype and a chain sealed here produce identical hashes.
 *
 * This package may do I/O-ish work (node:crypto); it is not safety-kernel. It
 * still has no network, no database and no state beyond the chain it returns.
 */

import { createHash } from 'node:crypto';
import type { PipelineLayer } from '@chittu/contracts';

/** The literal seed of every chain. The first record's `prev` is this string. */
export const GENESIS = 'GENESIS';

/**
 * The prototype truncates each digest to 16 hex chars so the parent ledger can
 * show a whole hash on a phone. Kept — changing it would invalidate every seal
 * already written and every screenshot in the compliance pack.
 */
export const HASH_HEX_LENGTH = 16;

/**
 * Who the record is about. Enumerated from the prototype's own `auditAdd` call
 * sites: 'system' (memory, consent, reading scores), 'chittu' (every reply),
 * 'child' (every input), 'parent' (gate, crisis ack, erasure).
 */
export type SealRole = 'system' | 'chittu' | 'child' | 'parent';

/**
 * The layer that produced the record. Pipeline layers come from @chittu/contracts,
 * but the prototype also seals events that never touch the pipeline ('MEMORY',
 * 'GATE', 'PARENT', 'INPUT·VOICE(discarded)') and trace labels carrying a note
 * ('SPINE · welcome + MEMORY', 'READING COACH · scripted'). `layer` is NOT part
 * of the hashed payload, so widening it cannot weaken the chain.
 */
export type SealLayer = PipelineLayer | (string & {});

/**
 * One sealed record. Field names are the prototype's, because the parent
 * dashboard renders them directly and the ledger table will mirror them.
 *
 * `payload` is stored rather than recomputed: verification must re-hash exactly
 * what was hashed at write time, even if `role` semantics change later.
 */
export interface SealRecord {
  /** Wall-clock stamp. Never hashed — see the deviation note on `append`. */
  readonly t: string;
  readonly role: SealRole;
  readonly layer: SealLayer;
  /** This record's hash: sha(prev + '|' + payload). */
  readonly h: string;
  /** The previous record's hash, or GENESIS for the first record. */
  readonly prev: string;
  /** role + '|' + text. The layer is deliberately absent. */
  readonly payload: string;
}

export interface SealVerification {
  readonly ok: boolean;
  /** Total records examined — the count the dashboard reports on success. */
  readonly records: number;
  /** Index of the first record that failed to recompute, or null. */
  readonly brokenAt: number | null;
}

/** One sealed event. Named fields so `layer` and `text` cannot be transposed. */
export interface SealEvent {
  readonly role: SealRole;
  readonly layer: SealLayer;
  /** The content being sealed. This — and only this — enters the hash. */
  readonly text: string;
}

export interface SealChain {
  /**
   * Seal one event. Resolves once the record is in the chain.
   *
   * Serialised: callers may fire in parallel, the chain still has one order.
   */
  /**
   * Named fields, not positional arguments, and deliberately so.
   *
   * The prototype's `auditAdd(role, text, layer)` and an earlier draft of this
   * port disagreed on argument 2 vs 3 — and because `layer` and `text` are both
   * strings, a transposed call typechecks, runs, and still verifies OK. The
   * damage is silent and total: the child's words land in `layer`, which is NOT
   * part of the hashed payload, while the layer name gets sealed in their place.
   * The chain then evidences nothing that was actually said.
   *
   * An object literal makes that mistake unrepresentable.
   */
  append(event: SealEvent): Promise<SealRecord>;
  /** Recompute the whole chain from GENESIS. */
  verify(): SealVerification;
  /** A snapshot of the sealed records, oldest first. */
  records(): readonly SealRecord[];
  /** The hash the next record will chain onto; GENESIS while empty. */
  head(): string;
  size(): number;
}

/**
 * SHA-256 over the UTF-8 bytes of `text`, lowercase hex, truncated.
 *
 * Byte-identical to the prototype's `crypto.subtle.digest('SHA-256',
 * new TextEncoder().encode(t))` — TextEncoder is UTF-8, so is update(…, 'utf8').
 */
export function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_HEX_LENGTH);
}

/**
 * Recompute a chain from GENESIS, exactly as the dashboard's verify loop does.
 *
 * Standalone rather than a method because verification must be able to run over
 * records that came from somewhere else — a database row set, an export file —
 * and not only over the in-memory chain that wrote them.
 *
 * PORTED AS-IS: the loop checks only `h`, never that `a.prev` equals the running
 * hash. A record whose `prev` field alone was edited still verifies. Left intact
 * deliberately; the recomputed hash is what carries the integrity claim.
 */
export function verifyRecords(records: readonly SealRecord[]): SealVerification {
  let prev = GENESIS;
  let i = 0;
  for (const a of records) {
    const h = sha(prev + '|' + a.payload);
    if (h !== a.h) return { ok: false, records: records.length, brokenAt: i };
    prev = h;
    i++;
  }
  return { ok: true, records: records.length, brokenAt: null };
}

export function createChain(): SealChain {
  const records: SealRecord[] = [];
  let lastHash: string = GENESIS;

  /**
   * The prototype's `auditQueue`. The .then() is attached synchronously inside
   * append, so the order callers *called* in is the order the chain is written
   * in — even when a hundred of them fire at once. Regression-locked invariant
   * (CLAUDE.md): the hash chain can never fork.
   */
  let queue: Promise<unknown> = Promise.resolve();

  return {
    append({ role, layer, text }) {
      const task = queue.then(() => {
        const payload = role + '|' + text;
        const prev = lastHash;
        const h = sha(prev + '|' + payload);
        const record: SealRecord = Object.freeze({
          t: new Date().toISOString(),
          role,
          layer,
          h,
          prev,
          payload,
        });
        records.push(record);
        lastHash = h;
        return record;
      });
      queue = task;
      return task;
    },
    verify() {
      return verifyRecords(records);
    },
    records() {
      return records.slice();
    },
    head() {
      return lastHash;
    },
    size() {
      return records.length;
    },
  };
}
