/**
 * Retrieval over the grounded corpus — the Merlyn pattern, architecture §9.4.
 *
 * The claim being implemented is §12.2's: "Merlyn answers only from
 * school-selected curriculum, not the open internet, at ~1–2% hallucination — a
 * model-level implementation of our Truth Wall". We do it at the retrieval
 * level instead: hand the sandbox a verified fact and rule 11 of the fifteen
 * hard rules tells it to answer FROM that.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * It is NOT a bypass. A grounded answer still walks L5 → L6 exactly like an
 * ungrounded one, and the escalation tokens still work: a model handed a fact
 * about volcanoes can still emit CRISIS, and it still locks the chat. Curated
 * truth changes what the model is told, never what happens to what it says.
 *
 * It is also NOT a licence to generate when retrieval finds nothing. A miss
 * returns null and rule 11's other half — "a kind 'I don't know' beats a
 * made-up answer" — is what the child gets. `runTurn` distinguishes the three
 * outcomes in the trace precisely so a miss cannot be mistaken for a hit that
 * happened to be quiet.
 *
 * ---------------------------------------------------------------------------
 * ONLY `published` IS EVER RETRIEVED
 *
 * The schema says so in a comment above `corpus_chunk_ann` and enforces half of
 * it in a CHECK (`published_must_be_signed`). The other half is this query, and
 * it is the half that matters at runtime: a draft entry is content nobody has
 * checked, and the whole value of a grounded corpus is that a second human
 * read it. W6 in the architecture doc exists because a critic pass over
 * authored content caught roughly 130 factual errors in llm-kit.
 *
 * `retired_at IS NULL` is the same rule for the other end of the lifecycle.
 * The state machine has a `retired` state, but state and timestamp are set
 * independently and a row that has one without the other must not be served.
 *
 * ---------------------------------------------------------------------------
 * EVERY METHOD TAKES `db`, AND CALLERS MUST PASS THEIR TRANSACTION
 *
 * The turn runs inside `withChild` (server.ts:681). Reading from `pool` inside
 * that transaction is a documented repeat offence in this repo — CLAUDE.md
 * records it happening twice. The corpus is not child data and `assert_child_scope`
 * has nothing to say about it, so the failure here is quieter than usual: the
 * read simply runs on a different connection, outside the caller's transaction,
 * and nothing complains. `pool` is the factory's fallback for CLI callers who
 * genuinely have no transaction; the pipeline path always passes `tx`.
 */

import type { Db, DbPool } from './client.js';

/**
 * The board sentinel for an entry that applies everywhere.
 *
 * `corpus_entry.board` is `NOT NULL`, so "applies to every board" needs a value
 * rather than an absence. A sentinel is deliberately chosen over a migration
 * dropping the constraint: making the column nullable would push a null check
 * into every future reader of the table, and a reader that forgets it gets a
 * row that silently matches nothing. A sentinel that a query must name
 * explicitly cannot be forgotten silently — the board scoping test fails.
 */
export const BOARD_ANY = '*';

/**
 * Chunks whose cosine distance exceeds this are not offered as grounding.
 *
 * MEASURED, not guessed. Against the fifteen seed entries embedded with
 * mxbai-embed-large, asking in a child's words rather than the corpus's:
 *
 *   why is the sky blue                    0.174  -> sky            HIT
 *   what makes the sky that colour         0.213  -> sky            HIT   (no shared keyword)
 *   how come aeroplanes stay up in the air  0.253  -> planes         HIT
 *   where does rain come from              0.284  -> water cycle    HIT
 *   how do plants eat                      0.307  -> photosynthesis HIT   ("photosynthesis" never said)
 *   what is a xylophone made of            0.590  -> (nearest)      MISS
 *   who won the world cup in 1998          0.639  -> (nearest)      MISS
 *
 * Two clearly separated populations, 0.31 and 0.59, and the floor sits in the
 * gap. Re-measure it if the embedding model changes: the number is a property
 * of that model's distance distribution, not a universal constant, and a floor
 * carried over to a different model is the same class of error as carrying the
 * vectors over.
 */
export const DEFAULT_MAX_DISTANCE = 0.45;

/** How many chunks the ANN query returns before the distance floor applies. */
export const DEFAULT_LIMIT = 3;

export const EMBEDDING_DIMS = 1024;

export interface CorpusHit {
  readonly entryId: string;
  readonly chunkId: string;
  readonly board: string;
  readonly subject: string;
  readonly topic: string;
  readonly body: string;
  /** Cosine distance, 0 = identical. Kept so a caller can log why it chose. */
  readonly distance: number;
}

export interface RetrieveQuery {
  readonly board: string;
  readonly embedding: readonly number[];
  /**
   * Optional narrowing. `detectSubject` returns null often enough that making
   * this required would turn "we could not name the subject" into "retrieve
   * nothing", which is the wrong direction: an unnamed subject should widen the
   * search, not close it.
   */
  readonly subject?: string | null;
  readonly limit?: number;
  readonly maxDistance?: number;
}

export interface CorpusEntryInput {
  readonly board: string;
  readonly classLevel?: string | null;
  readonly subject: string;
  readonly topic: string;
  readonly body: string;
  readonly sourceUrl?: string | null;
  readonly draftedBy: string;
  /** One vector per chunk, in `ord` order. Each must be EMBEDDING_DIMS long. */
  readonly chunks: readonly { readonly body: string; readonly embedding: readonly number[] }[];
}

export interface CorpusEntryRow {
  readonly id: string;
  readonly board: string;
  readonly subject: string;
  readonly topic: string;
  readonly body: string;
  readonly state: string;
  readonly signedBy: string | null;
  readonly chunks: number;
}

/**
 * pgvector's text input format. Not `JSON.stringify` by accident — pgvector
 * happens to accept that shape for a flat array of finite numbers, and relying
 * on the coincidence would break the first time a caller passed something
 * JSON.stringify renders differently (a `null` from a sparse array becomes
 * `null`, which pgvector rejects with a parse error naming a column rather than
 * the caller).
 */
function toVector(v: readonly number[]): string {
  if (v.length !== EMBEDDING_DIMS) {
    throw new Error(
      `embedding must be ${EMBEDDING_DIMS} dimensions, got ${v.length}`);
  }
  for (const n of v) {
    if (!Number.isFinite(n)) throw new Error('embedding contains a non-finite value');
  }
  return `[${v.join(',')}]`;
}

interface RawHit {
  entry_id: string;
  chunk_id: string;
  board: string;
  subject: string;
  topic: string;
  body: string;
  distance: string | number;
}

export function corpusRepo(pool: DbPool) {
  return {
    /**
     * Nearest published chunks, board-scoped.
     *
     * The ORDER BY is left in the canonical `<=> … LIMIT n` shape that pgvector
     * needs in order to use the HNSW index; the distance floor is applied in TS
     * afterwards rather than as a WHERE clause. At corpus scale that costs
     * nothing measurable, and a distance predicate in the WHERE is exactly the
     * shape that makes the planner abandon the index for a sequential scan —
     * which would still return correct rows, so nothing would ever fail.
     */
    async retrieve(db: Db, q: RetrieveQuery): Promise<CorpusHit[]> {
      const vec = toVector(q.embedding);
      const limit = q.limit ?? DEFAULT_LIMIT;
      const maxDistance = q.maxDistance ?? DEFAULT_MAX_DISTANCE;
      const r = await db.query<RawHit>(
        `SELECT e.id            AS entry_id,
                c.id            AS chunk_id,
                e.board         AS board,
                e.subject       AS subject,
                e.topic         AS topic,
                c.body          AS body,
                c.embedding <=> $1::vector AS distance
           FROM corpus_chunk c
           JOIN corpus_entry e ON e.id = c.entry_id
          WHERE e.state = 'published'
            AND e.retired_at IS NULL
            AND (e.board = $2 OR e.board = $3)
            AND ($4::text IS NULL OR e.subject = $4)
          ORDER BY c.embedding <=> $1::vector
          LIMIT $5`,
        [vec, q.board, BOARD_ANY, q.subject ?? null, limit]);

      return r.rows
        .map((row) => ({
          entryId: row.entry_id,
          chunkId: row.chunk_id,
          board: row.board,
          subject: row.subject,
          topic: row.topic,
          body: row.body,
          distance: Number(row.distance),
        }))
        .filter((h) => h.distance <= maxDistance);
    },

    /**
     * Author an entry. Lands as `draft` — the DEFAULT on the column, restated
     * here because it is the point rather than an incidental.
     *
     * There is no parameter to insert something already published. Promotion is
     * `sign()`, which needs a name, for the same reason `signalRepo.promote`
     * is separate from `observe`: the judgement belongs to a person. A helper
     * that took `state` as an argument would make "publish it straight away"
     * a keystroke, and the helpline CLI's lesson — importing is NOT verifying —
     * is that the keystroke is exactly what gets taken.
     */
    async draft(db: Db, entry: CorpusEntryInput): Promise<string> {
      if (entry.chunks.length === 0) {
        throw new Error('a corpus entry needs at least one chunk');
      }
      const vectors = entry.chunks.map((c) => toVector(c.embedding));
      const r = await db.query<{ id: string }>(
        `INSERT INTO corpus_entry (board, class_level, subject, topic, body, source_url, drafted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [entry.board, entry.classLevel ?? null, entry.subject, entry.topic,
          entry.body, entry.sourceUrl ?? null, entry.draftedBy]);
      const id = r.rows[0]!.id;
      for (const [i, chunk] of entry.chunks.entries()) {
        await db.query(
          `INSERT INTO corpus_chunk (entry_id, ord, body, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [id, i, chunk.body, vectors[i]!]);
      }
      return id;
    },

    /**
     * draft/verified/signed -> published, by a named human.
     *
     * Sets `signed_by` and `signed_at` in the same statement that sets
     * `published`, because `published_must_be_signed` is a CHECK and a two-step
     * that published first would simply fail — correctly, and confusingly. The
     * WHERE excludes rows that are already published so a re-run is a no-op
     * rather than a second signature overwriting the first.
     */
    async sign(db: Db, id: string, signedBy: string, now: Date = new Date()): Promise<boolean> {
      // RETURNING, not a row count: the `Db` port exposes `rows` alone, which
      // is the narrower surface an in-memory or wrapped connection can also
      // satisfy. Reaching for `rowCount` would tie this repo to node-postgres.
      const r = await db.query<{ id: string }>(
        `UPDATE corpus_entry
            SET state = 'published', signed_by = $2, signed_at = $3, published_at = $3
          WHERE id = $1 AND state <> 'published' AND retired_at IS NULL
          RETURNING id`,
        [id, signedBy, now.toISOString()]);
      return r.rows.length > 0;
    },

    async listEntries(db: Db = pool): Promise<CorpusEntryRow[]> {
      const r = await db.query<{
        id: string; board: string; subject: string; topic: string;
        body: string; state: string; signed_by: string | null; chunks: string;
      }>(
        `SELECT e.id, e.board, e.subject, e.topic, e.body, e.state, e.signed_by,
                count(c.id) AS chunks
           FROM corpus_entry e
           LEFT JOIN corpus_chunk c ON c.entry_id = e.id
          GROUP BY e.id
          ORDER BY e.board, e.subject, e.topic`);
      return r.rows.map((row) => ({
        id: row.id, board: row.board, subject: row.subject, topic: row.topic,
        body: row.body, state: row.state, signedBy: row.signed_by,
        chunks: Number(row.chunks),
      }));
    },

    /** Whether a given topic already exists on a board — the import's idempotency. */
    async findByTopic(db: Db, board: string, topic: string): Promise<string | null> {
      const r = await db.query<{ id: string }>(
        `SELECT id FROM corpus_entry WHERE board = $1 AND topic = $2 LIMIT 1`,
        [board, topic]);
      return r.rows[0]?.id ?? null;
    },
  };
}

export type CorpusRepo = ReturnType<typeof corpusRepo>;
