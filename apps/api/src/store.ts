/**
 * Everything the API needs from the database, in one place.
 *
 * There is deliberately no in-memory alternative. Two implementations of a
 * persistence layer means two code paths, and the one the tests exercise is
 * never quite the one production runs — so tests use PGlite, which IS Postgres,
 * and the only path is this one.
 */

import { randomUUID } from 'node:crypto';
import type { Band, Memory, Mode } from '@chittu/contracts';
import type { SessionState } from '@chittu/pipeline';
import {
  auditRepo, childRepo, consentRepo, withChildScope,
  encrypt, decrypt, toBuffer,
  type DbPool, type Db, type KeyProvider,
} from '@chittu/db';

/** The slice of pipeline state that has no column of its own. */
interface RuntimeState {
  mathPractice: SessionState['mathPractice'];
  history: SessionState['history'];
  /**
   * The classifier's window — the child's own turns. Separate from `history`
   * because they answer different questions, and because collapsing them meant
   * removing a turn from the model's context also removed it from the window of
   * the layer whose job is patterns across turns.
   */
  recentKid: SessionState['recentKid'];
  topics: string[];
  assists: string[];
  lastSubject: SessionState['lastSubject'];
}

const EMPTY_RUNTIME: RuntimeState = {
  mathPractice: null, history: [], recentKid: [], topics: [], assists: [], lastSubject: null,
};

/** Classifier window (§5: 3-message rolling window). Bounded so it cannot grow. */
const HISTORY_WINDOW = 6;   // three exchanges

export function createStore(pool: DbPool, keys: KeyProvider) {
  const consent = consentRepo(pool, keys);
  const child = childRepo(pool, keys);
  const audit = auditRepo(pool);

  async function readRuntime(tx: Db, sessionId: string, childId: string): Promise<RuntimeState> {
    const r = await tx.query<{ runtime_enc: Buffer | null }>(
      `SELECT runtime_enc FROM session WHERE id = $1`, [sessionId]);
    const blob = r.rows[0]?.runtime_enc;
    if (!blob) return { ...EMPTY_RUNTIME };
    const dek = await child.dekFor(tx, childId);
    // Spread over the empty shape: a blob written before a field existed
    // parses without it, and `undefined.slice` is how that would announce
    // itself — on a live session, mid-turn.
    return { ...EMPTY_RUNTIME, ...JSON.parse(decrypt(toBuffer(blob), dek)) } as RuntimeState;
  }

  async function writeRuntime(
    tx: Db, sessionId: string, childId: string, state: RuntimeState,
  ): Promise<void> {
    const dek = await child.dekFor(tx, childId);
    const trimmed: RuntimeState = {
      ...state,
      history: state.history.slice(-HISTORY_WINDOW),
      recentKid: state.recentKid.slice(-HISTORY_WINDOW),
    };
    await tx.query(`UPDATE session SET runtime_enc = $2 WHERE id = $1`,
      [sessionId, encrypt(JSON.stringify(trimmed), dek)]);
  }

  return {
    consent, child, audit,

    /** An appender that writes through to `audit_event` inside the caller's tx. */
    sealFor(tx: Db, sessionId: string) {
      return {
        append: (e: { role: string; layer: string; text: string }) =>
          audit.append(tx, {
            sessionId,
            // the schema's msg_role has no 'parent'; parent actions seal as system
            role: e.role === 'child' || e.role === 'chittu' ? e.role : 'system',
            layer: e.layer,
            text: e.text,
          }),
      };
    },

    /**
     * Rebuild the pipeline's view of a session from what is stored.
     *
     * @param helplines resolved for this turn by the caller. The pipeline never
     *   reads the registry itself — a turn stays a pure function of its inputs,
     *   and the crisis reply is producible with no database at all.
     */
    async loadSession(tx: Db, sessionId: string, helplines?: string | null): Promise<{
      state: SessionState; childId: string; consentId: string;
    } | null> {
      const s = await child.getSession(tx, sessionId);
      if (!s || s.endedAt) return null;
      const stored = await consent.byId(tx, s.consentId);
      if (!stored) return null;
      const rt = await readRuntime(tx, sessionId, s.childId);
      return {
        childId: s.childId,
        consentId: s.consentId,
        state: {
          kid: stored.record.childFirstName,
          band: s.band,
          country: stored.record.country,
          helplines: helplines ?? null,
          board: stored.record.board,
          mode: 'chat',
          crisisLock: s.crisisLock,
          memOn: stored.record.scopes.includes('memory'),
          memories: await child.listMemories(tx, s.childId),
          mathPractice: rt.mathPractice,
          history: rt.history,
          recentKid: rt.recentKid,
          spineCount: s.spineCount,
          flags: [],           // flags are read from the DB by the parent view
          topics: rt.topics,
          assists: rt.assists,
          lastSubject: rt.lastSubject,
        },
      };
    },

    /** Persist everything a turn changed, in the caller's transaction. */
    async saveTurn(
      tx: Db, sessionId: string, childId: string, band: Band,
      after: SessionState,
      mode: Mode, childText: string, replyText: string, trace: string,
      layers: readonly string[],
      newFlags: readonly { kind: 'SAFETY' | 'ASSIST' | 'GATE'; noteKey: string; assistTopic?: string }[],
      savedMemory: Memory | undefined,
    ): Promise<void> {
      await child.addMessage(tx, sessionId, childId, band, 'child',
        childText, after.lastSubject, mode, {});
      // the ordered walk lives here, machine-readable, beside the label
      await child.addMessage(tx, sessionId, childId, band, 'chittu',
        replyText, after.lastSubject, mode, { trace, layers });

      for (const f of newFlags) {
        await child.addFlag(tx, childId, sessionId, f.kind, f.noteKey, f.assistTopic);
      }
      if (savedMemory) {
        await child.addMemory(tx, childId, savedMemory.category, savedMemory.fact, sessionId);
      }
      await child.updateSession(tx, sessionId, {
        crisisLock: after.crisisLock,
        spineCount: after.spineCount,
      });
      // incremented rather than set, so a concurrent turn cannot clobber the count
      await tx.query(`UPDATE session SET msg_count = msg_count + 1 WHERE id = $1`,
        [sessionId]);
      await writeRuntime(tx, sessionId, childId, {
        mathPractice: after.mathPractice,
        history: [...after.history],
        recentKid: [...after.recentKid],
        topics: [...after.topics],
        assists: [...after.assists],
        lastSubject: after.lastSubject,
      });
    },

    /**
     * Open a session for an already-verified consent — or resume the live one.
     *
     * Resuming is a safety control: `crisis_lock` is per-session, so always
     * creating a new session made a page reload an escape from it. See
     * `openOrResumeSession`.
     */
    async openSession(childId: string, consentId: string, band: Band): Promise<{
      id: string; resumed: boolean; crisisLock: boolean;
    }> {
      return withChildScope(pool, childId, (tx) =>
        child.openOrResumeSession(tx, childId, consentId, band));
    },

    withChild<T>(childId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
      return withChildScope(pool, childId, fn);
    },

    newId: () => randomUUID(),
  };
}

export type Store = ReturnType<typeof createStore>;
