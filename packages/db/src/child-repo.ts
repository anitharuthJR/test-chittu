/**
 * Sessions, messages, memories and flags.
 *
 * Every method here takes a `tx` already inside `withChildScope`. That is not a
 * style preference: RLS filters these tables on `chittu.child_id`, and an
 * unscoped query returns zero rows and succeeds. Requiring the caller to hold a
 * scope makes "I forgot to set it" a compile-time shape rather than a silent
 * empty result.
 */

import type { Band, Memory, MemoryCategory, Mode } from '@chittu/contracts';
import { MEMORY_CATEGORIES } from '@chittu/contracts';
import type { Db, DbPool } from './client';
import { encrypt, decrypt, fingerprint, type KeyProvider } from './crypto';
import { toBuffer } from './consent-repo';

/** Default conversation retention. Architecture doc §6.3 — a proposal, not a ruling. */
export const MESSAGE_TTL_DAYS = 30;

export interface SessionRow {
  readonly id: string;
  readonly childId: string;
  readonly consentId: string;
  readonly band: Band;
  readonly crisisLock: boolean;
  readonly endedAt: string | null;
  readonly msgCount: number;
  readonly spineCount: number;
}

export function childRepo(pool: DbPool, keys: KeyProvider) {
  /** Unwrap a child's DEK. Throws a named error once the child is shredded. */
  async function dekFor(tx: Db, childId: string): Promise<Buffer> {
    const r = await tx.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
      `SELECT wrapped_dek, kms_key_arn FROM child_data_key WHERE child_id = $1`,
      [childId]);
    const row = r.rows[0];
    if (!row) throw new Error(`no data key for child ${childId}`);
    return keys.unwrap(toBuffer(row.wrapped_dek), row.kms_key_arn);
  }

  return {
    dekFor,

    async openSession(
      tx: Db, childId: string, consentId: string, band: Band,
    ): Promise<string> {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO session (child_id, consent_id, band) VALUES ($1,$2,$3) RETURNING id`,
        [childId, consentId, band]);
      return r.rows[0]!.id;
    },

    async getSession(tx: Db, sessionId: string): Promise<SessionRow | null> {
      const r = await tx.query<{
        id: string; child_id: string; consent_id: string; band: Band;
        crisis_lock: boolean; ended_at: string | null;
        msg_count: number; spine_count: number;
      }>(`SELECT id, child_id, consent_id, band, crisis_lock, ended_at,
                 msg_count, spine_count FROM session WHERE id = $1`, [sessionId]);
      const s = r.rows[0];
      return s ? {
        id: s.id, childId: s.child_id, consentId: s.consent_id, band: s.band,
        crisisLock: s.crisis_lock,
        endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null,
        msgCount: s.msg_count, spineCount: s.spine_count,
      } : null;
    },

    async updateSession(
      tx: Db, sessionId: string,
      patch: { crisisLock?: boolean; msgCount?: number; spineCount?: number },
    ): Promise<void> {
      await tx.query(
        `UPDATE session SET
           crisis_lock = COALESCE($2, crisis_lock),
           locked_at = CASE WHEN $2 IS TRUE AND locked_at IS NULL THEN now() ELSE locked_at END,
           msg_count = COALESCE($3, msg_count),
           spine_count = COALESCE($4, spine_count)
         WHERE id = $1`,
        [sessionId, patch.crisisLock ?? null, patch.msgCount ?? null,
         patch.spineCount ?? null]);
    },

    /** The only unlock path. Records WHO, because "a parent said so" is the point. */
    async acknowledgeCrisis(tx: Db, sessionId: string, parentId: string): Promise<void> {
      await tx.query(
        `UPDATE session SET crisis_lock = false, unlocked_at = now(), unlocked_by = $2
          WHERE id = $1`, [sessionId, parentId]);
    },

    /**
     * Append a turn.
     *
     * The body is encrypted, and for `thinker` it is not stored at all — the
     * database CHECK would reject a body anyway, so passing null here is not
     * belt-and-braces so much as agreeing with the constraint before it has to
     * argue. The topic is kept for every band; it is what a teen's parent sees.
     */
    async addMessage(
      tx: Db, sessionId: string, childId: string, band: Band,
      role: 'child' | 'chittu' | 'system', body: string,
      topic: string | null, mode: Mode | null, trace: unknown,
    ): Promise<void> {
      const seq = await tx.query<{ n: number }>(
        `SELECT COALESCE(max(seq), -1) + 1 AS n FROM message WHERE session_id = $1`,
        [sessionId]);
      const bodyEnc = band === 'thinker'
        ? null
        : encrypt(body, await dekFor(tx, childId));
      await tx.query(
        `INSERT INTO message (session_id, seq, role, band, body_enc, topic, mode, trace, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' days')::interval)`,
        [sessionId, seq.rows[0]!.n, role, band, bodyEnc, topic, mode,
         JSON.stringify(trace ?? {}), String(MESSAGE_TTL_DAYS)]);
    },

    /** Full transcript for 4–12; topics only for teens, because bodies do not exist. */
    async transcript(tx: Db, sessionId: string, childId: string): Promise<
      { seq: number; role: string; body: string | null; topic: string | null }[]
    > {
      const r = await tx.query<{
        seq: number; role: string; body_enc: Buffer | null; topic: string | null;
      }>(`SELECT seq, role, body_enc, topic FROM message
           WHERE session_id = $1 ORDER BY seq ASC`, [sessionId]);
      if (r.rows.length === 0) return [];
      const needsKey = r.rows.some((x) => x.body_enc !== null);
      const dek = needsKey ? await dekFor(tx, childId) : null;
      return r.rows.map((x) => ({
        seq: x.seq, role: x.role, topic: x.topic,
        body: x.body_enc && dek ? decrypt(toBuffer(x.body_enc), dek) : null,
      }));
    },

    // ---- memory ---------------------------------------------------------

    /**
     * The allowlist is checked HERE as well as by the enum, because a rejected
     * memory should be a quiet no-op rather than a failed turn. The database is
     * the backstop; this is the behaviour.
     */
    async addMemory(
      tx: Db, childId: string, category: string, fact: string, sessionId: string,
    ): Promise<Memory | null> {
      if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) return null;
      const trimmed = fact.trim();
      if (!trimmed) return null;
      const dek = await dekFor(tx, childId);
      const indexKey = await keys.indexKey();
      const r = await tx.query<{ id: string; since: string }>(
        `INSERT INTO memory (child_id, category, fact_enc, fact_fingerprint, provenance_session)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING
         RETURNING id, since`,
        [childId, category, encrypt(trimmed, dek),
         fingerprint(trimmed, indexKey), sessionId]);
      const row = r.rows[0];
      if (!row) return null;   // duplicate — the unique index caught it
      return {
        id: row.id, category: category as MemoryCategory, fact: trimmed,
        since: new Date(row.since).toISOString(),
      };
    },

    async listMemories(tx: Db, childId: string): Promise<Memory[]> {
      const r = await tx.query<{
        id: string; category: MemoryCategory; fact_enc: Buffer; since: string;
      }>(`SELECT id, category, fact_enc, since FROM memory
           WHERE child_id = $1 AND deleted_at IS NULL ORDER BY since ASC`, [childId]);
      if (r.rows.length === 0) return [];
      const dek = await dekFor(tx, childId);
      return r.rows.map((x) => ({
        id: x.id, category: x.category,
        fact: decrypt(toBuffer(x.fact_enc), dek),
        since: new Date(x.since).toISOString(),
      }));
    },

    /** Child and parent can both delete. `deleted_by` records which. */
    async forgetMemory(
      tx: Db, childId: string, memoryId: string, by: 'child' | 'parent',
    ): Promise<boolean> {
      const r = await tx.query(
        `UPDATE memory SET deleted_at = now(), deleted_by = $3
          WHERE id = $2 AND child_id = $1 AND deleted_at IS NULL RETURNING id`,
        [childId, memoryId, by]);
      return r.rows.length > 0;
    },

    // ---- flags ----------------------------------------------------------

    /**
     * A flag names a template key and, for ASSIST, a bare topic. There is no
     * parameter here through which a child's words could travel, which mirrors
     * the table having no column for them.
     */
    async addFlag(
      tx: Db, childId: string, sessionId: string,
      kind: 'SAFETY' | 'ASSIST' | 'GATE', noteKey: string, assistTopic?: string,
    ): Promise<void> {
      await tx.query(
        `INSERT INTO flag (child_id, session_id, kind, note_key, assist_topic)
         VALUES ($1,$2,$3,$4,$5)`,
        [childId, sessionId, kind, noteKey, assistTopic ?? null]);
    },

    /**
     * Counts for the parent dashboard, in one round trip.
     *
     * Everything here is an aggregate. There is no path through this function
     * that returns a child's words, which is why it can be computed without
     * touching the DEK at all.
     */
    async stats(tx: Db, childId: string): Promise<{
      sessions: number; messages: number; spines: number; crisisLocked: boolean;
      firstSeen: string | null; lastSeen: string | null;
    }> {
      const r = await tx.query<{
        sessions: string; messages: string; spines: string;
        locked: boolean; first_seen: string | null; last_seen: string | null;
      }>(
        `SELECT count(*)::text                               AS sessions,
                coalesce(sum(msg_count),0)::text             AS messages,
                coalesce(sum(spine_count),0)::text           AS spines,
                bool_or(crisis_lock)                         AS locked,
                min(started_at)                              AS first_seen,
                max(coalesce(ended_at, started_at))          AS last_seen
           FROM session WHERE child_id = $1`, [childId]);
      const x = r.rows[0];
      return {
        sessions: Number(x?.sessions ?? 0),
        messages: Number(x?.messages ?? 0),
        spines: Number(x?.spines ?? 0),
        crisisLocked: x?.locked ?? false,
        firstSeen: x?.first_seen ? new Date(x.first_seen).toISOString() : null,
        lastSeen: x?.last_seen ? new Date(x.last_seen).toISOString() : null,
      };
    },

    /** One row per conversation, for the list a parent picks from. */
    async sessionList(tx: Db, childId: string): Promise<{
      id: string; band: string; startedAt: string; endedAt: string | null;
      msgCount: number; crisisLock: boolean;
    }[]> {
      const r = await tx.query<{
        id: string; band: string; started_at: string; ended_at: string | null;
        msg_count: number; crisis_lock: boolean;
      }>(`SELECT id, band, started_at, ended_at, msg_count, crisis_lock
            FROM session WHERE child_id = $1 ORDER BY started_at DESC LIMIT 100`,
        [childId]);
      return r.rows.map((x) => ({
        id: x.id, band: x.band,
        startedAt: new Date(x.started_at).toISOString(),
        endedAt: x.ended_at ? new Date(x.ended_at).toISOString() : null,
        msgCount: x.msg_count, crisisLock: x.crisis_lock,
      }));
    },

    async listFlags(tx: Db, childId: string): Promise<
      { kind: string; category: string; body: string; at: string; topic: string | null }[]
    > {
      const r = await tx.query<{
        kind: string; category: string; body: string;
        created_at: string; assist_topic: string | null;
      }>(`SELECT f.kind, t.category, t.body, f.created_at, f.assist_topic
            FROM flag f JOIN flag_note_template t ON t.key = f.note_key
           WHERE f.child_id = $1 ORDER BY f.created_at DESC`, [childId]);
      return r.rows.map((x) => ({
        kind: x.kind, category: x.category, body: x.body,
        at: new Date(x.created_at).toISOString(), topic: x.assist_topic,
      }));
    },
  };
}

export type ChildRepo = ReturnType<typeof childRepo>;
