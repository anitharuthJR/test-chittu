/**
 * What model calls cost, against a session nobody can reverse.
 *
 * §4.6: "pseudonymised; admin sees cost, never children". The schema has NO
 * foreign key from `metering` to `session`, deliberately — the ops console
 * aggregates per session without being able to reach a child.
 *
 * This table holds no text and cannot be made to: `metering-repo.test.ts`
 * enumerates its columns, so adding one that could carry a sentence has to be
 * argued for in that test first.
 */

import { createHmac } from 'node:crypto';
import type { Db } from './client.js';

/**
 * `HMAC(session_id, key)` with a DOMAIN TAG.
 *
 * The tag is the point. `fingerprint()` is an HMAC under the same index key,
 * so without domain separation anyone holding that key could compute a
 * session's pseudonym from its id and link spend back to a child — which is the
 * one thing this column exists to prevent. Two different questions must not
 * share an answer.
 *
 * NOT rotating yet. The schema comment says `HMAC(session_id, rotating_key)`;
 * this uses the deterministic index key, so a pseudonym is stable for the life
 * of that key. Stability is what per-session aggregation needs, and rotation is
 * a retention decision nobody has made — recorded in docs/chittu-model-plan.md
 * §5 rather than silently chosen here.
 */
export function sessionPseudonym(sessionId: string, indexKey: Buffer): Buffer {
  return createHmac('sha256', indexKey)
    .update('chittu:metering:session:v1|', 'utf8')
    .update(sessionId, 'utf8')
    .digest();
}

/** Shape of `@chittu/contracts`' ModelUsage, declared here so db owns no port types. */
export interface MeteredCall {
  readonly category: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

export interface MeteredCost {
  readonly usd: number;
  readonly inr: number;
  readonly rateVersion: string;
}

export const meteringRepo = {
  /**
   * One row per model call.
   *
   * THROWS on failure, deliberately. Whether a metering failure should cost a
   * child their answer is not this function's decision — the caller makes it,
   * at the call site, where it is visible. (It should not: see server.ts.)
   */
  async record(
    db: Db, sessionPseudonymBytes: Buffer, call: MeteredCall, cost: MeteredCost,
  ): Promise<void> {
    await db.query(
      `INSERT INTO metering
         (session_pseudonym, call_type, provider, model, prompt_version,
          tokens_in, tokens_out, latency_ms, cost_usd, cost_inr, rate_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [sessionPseudonymBytes, call.category, call.provider, call.model,
        call.promptVersion, call.tokensIn, call.tokensOut, call.latencyMs,
        cost.usd, cost.inr, cost.rateVersion]);
  },
};
