/**
 * Who is using Chittu — named, counted, and correctable.
 *
 * THE LINE THIS FILE DRAWS, stated so it can be argued with.
 *
 * An operator handling a support request needs to find the family the request
 * is about, which means a name and an email; and needs to be able to fix a
 * record, which means an edit and an erase. So this page shows and writes both.
 * The line is drawn one step further in than it used to be, and it is still a
 * line: there is no transcript here, no memory fact, no flag note, and no
 * message body. `message` is a table no query in this file names — turn counts
 * come from the `session.msg_count` counter — so the console can tell you a
 * child sent forty turns and cannot tell you a single word of them.
 *
 * DECRYPTION IS REAL AND IS ACCOUNTED FOR. Names and emails are encrypted under
 * a child's DEK, so rendering them unwraps that DEK — one KMS call per child on
 * the page, cached per request. That is the honest cost of a console that shows
 * a person, and it is the reason there is no search box: pagination reads a
 * page, and a search would unwrap a key for every family that matched.
 *
 * THE PARENT'S EMAIL LIVES UNDER THE FIRST CHILD'S DEK. `createDraft` encrypts
 * it with the DEK it generated for the child in the same transaction, and a
 * second enrolment does not re-encrypt it. So the key for a parent's email is
 * the OLDEST child's, and erasing that child shreds it: the parent row survives
 * with an email nobody can read again. That is a consequence of the existing
 * schema rather than of this file, it is surfaced in the UI rather than hidden,
 * and it is worth someone deciding about on purpose.
 *
 * EVERY WRITE IS AUDITED AND EVERY WRITE NEEDS A REASON. `ops_action` takes the
 * actor from the SESSION, never from the form, and the database refuses a blank
 * reason — the same shape `provider_cell` already uses for a routing change.
 * The audit stores WHICH fields moved, never what they became: a row saying
 * "email changed from a@… to b@…" would be a plaintext copy of the one adult
 * identifier we hold, in a table with no DEK and no shred path.
 *
 * A BAND CHANGE WRITES A NEW CONSENT VERSION, IT DOES NOT UPDATE ONE. The
 * ledger is append-only by design (schema §2: "a change of toggles or band
 * writes a new row that supersedes the old one"), so `editChild` supersedes,
 * carrying the bearer token across in the same transaction — otherwise a
 * correction by an operator would silently sign the family out.
 *
 * ON THE GRANT BLOCK. `0001_init.sql` says "the ops console never touches
 * child-scoped tables at all". That is no longer true, and
 * `0009_ops_users.sql` says what is true instead, column by column.
 */

import { consentRepo, decrypt, encrypt, fingerprint, toBuffer } from '@chittu/db';
import type { Db, DbPool, KeyProvider } from '@chittu/db';
import { supersede } from '@chittu/consent';
import { BANDS, type Band } from '@chittu/contracts';

/** Families per page. Twenty-five fits a screen without a scroll on a laptop. */
export const PER_PAGE = 25;

/** The handle an operator sees. Never the whole id — that is a lookup key. */
export function handle(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

export interface UserChild {
  readonly id: string;
  readonly parentId: string;
  /** Decrypted for display. `null` when the DEK is shredded — an erased child. */
  readonly firstName: string | null;
  readonly band: string;
  readonly country: string;
  readonly board: string;
  readonly createdAt: Date;
  readonly erased: boolean;
  readonly consentStatus: string | null;
  readonly memoryOn: boolean | null;
  readonly learnOn: boolean | null;
  readonly sessions: number;
  readonly live: number;
  readonly messages: number;
  readonly spine: number;
  readonly locks: number;
  readonly lastSeen: Date | null;
  readonly readAttempts: number;
  readonly readWords: number;
  readonly readHits: number;
  readonly memories: number;
  readonly flagsOpen: number;
  readonly flagsTotal: number;
}

export interface UserParent {
  readonly id: string;
  readonly createdAt: Date;
  readonly locale: string;
  readonly erased: boolean;
  /**
   * Decrypted under the OLDEST child's DEK, which is the key `createDraft`
   * used. `null` means that child has been erased and the key is shredded, so
   * the parent's email is unreadable from here on — which the page says out
   * loud rather than showing an empty cell.
   */
  readonly name: string | null;
  readonly email: string | null;
  readonly children: readonly UserChild[];
  /** Rolled up from `children` in JS — one pass, no second aggregate query. */
  readonly sessions: number;
  readonly messages: number;
  readonly locks: number;
  readonly flagsOpen: number;
  readonly memories: number;
  readonly lastSeen: Date | null;
}

export interface UserTotals {
  readonly parents: number;
  readonly children: number;
  readonly consentActive: number;
  readonly consentPending: number;
  readonly consentRevoked: number;
  readonly sessions: number;
  readonly sessionsLive: number;
  readonly messages: number;
  readonly spine: number;
  readonly crisisLocks: number;
  readonly locksOpen: number;
  readonly flagsOpen: number;
  readonly memories: number;
  readonly activeToday: number;
}

export interface UsersView {
  readonly totals: UserTotals;
  readonly parents: readonly UserParent[];
  readonly page: number;
  readonly pageCount: number;
}

/**
 * One statement, ten scalar subqueries. Cheaper than ten round trips and, more
 * usefully, one consistent snapshot: a family enrolling mid-render cannot make
 * the child count disagree with the parent count.
 */
const TOTALS_SQL = `
  SELECT
    (SELECT count(*) FROM parent)::int                                   AS parents,
    (SELECT count(*) FROM child WHERE deleted_at IS NULL)::int           AS children,
    (SELECT count(*) FROM consent_record WHERE status = 'active')::int   AS consent_active,
    (SELECT count(*) FROM consent_record
      WHERE status IN ('draft','verifying'))::int                        AS consent_pending,
    (SELECT count(*) FROM consent_record WHERE status = 'revoked')::int  AS consent_revoked,
    (SELECT count(*) FROM session)::int                                  AS sessions,
    (SELECT count(*) FROM session WHERE ended_at IS NULL)::int           AS sessions_live,
    (SELECT coalesce(sum(msg_count), 0) FROM session)::int               AS messages,
    (SELECT coalesce(sum(spine_count), 0) FROM session)::int             AS spine,
    (SELECT count(*) FROM session WHERE crisis_lock)::int                AS crisis_locks,
    (SELECT count(*) FROM session
      WHERE crisis_lock AND unlocked_at IS NULL)::int                    AS locks_open,
    (SELECT count(*) FROM flag WHERE acknowledged_at IS NULL)::int       AS flags_open,
    (SELECT count(*) FROM memory WHERE deleted_at IS NULL)::int          AS memories,
    (SELECT count(DISTINCT child_id) FROM session
      WHERE started_at > now() - interval '24 hours')::int               AS active_today`;

/**
 * Newest family first. An ops console is read to answer "what happened lately",
 * and a stable secondary key (`id`) keeps two families enrolled in the same
 * millisecond from swapping places between page 1 and page 2 — the classic way
 * an OFFSET pager silently skips a row.
 */
const PARENTS_SQL = `
  SELECT id, created_at, locale, deleted_at, email_enc, display_name_enc
    FROM parent ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`;

/**
 * Every child of the parents on this page, with its counters, in ONE query.
 * LATERAL rather than four LEFT JOINs with GROUP BY: each subquery hits an
 * index on `child_id` and returns one row, so there is no join fan-out to
 * de-duplicate and no chance of a sum being multiplied by another table's
 * row count — which is the bug that shape of query always produces eventually.
 */
const CHILDREN_SQL = `
  SELECT c.id, c.parent_id, c.band::text AS band, c.country::text AS country,
         c.board, c.created_at, c.deleted_at, c.first_name_enc,
         k.wrapped_dek, k.kms_key_arn, k.shredded_at,
         cr.status AS consent_status, cr.memory_on, cr.learn_on,
         s.sessions, s.live, s.messages, s.spine, s.locks, s.last_seen,
         s.read_attempts, s.read_words, s.read_hits,
         m.memories, f.flags_open, f.flags_total
    FROM child c
    LEFT JOIN child_data_key k ON k.child_id = c.id
    LEFT JOIN LATERAL (
      SELECT count(*)::int                                       AS sessions,
             (count(*) FILTER (WHERE ended_at IS NULL))::int      AS live,
             coalesce(sum(msg_count), 0)::int                     AS messages,
             coalesce(sum(spine_count), 0)::int                   AS spine,
             (count(*) FILTER (WHERE crisis_lock))::int           AS locks,
             max(started_at)                                      AS last_seen,
             coalesce(sum(read_attempts), 0)::int                 AS read_attempts,
             coalesce(sum(read_words), 0)::int                    AS read_words,
             coalesce(sum(read_hits), 0)::int                     AS read_hits
        FROM session WHERE child_id = c.id) s ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS memories
        FROM memory WHERE child_id = c.id AND deleted_at IS NULL) m ON true
    LEFT JOIN LATERAL (
      SELECT (count(*) FILTER (WHERE acknowledged_at IS NULL))::int AS flags_open,
             count(*)::int                                          AS flags_total
        FROM flag WHERE child_id = c.id) f ON true
    LEFT JOIN LATERAL (
      SELECT status::text AS status, memory_on, learn_on
        FROM consent_record WHERE child_id = c.id
        ORDER BY version DESC, created_at DESC LIMIT 1) cr ON true
   WHERE c.parent_id = ANY($1::uuid[])
   ORDER BY c.created_at ASC, c.id ASC`;

interface ParentRow {
  id: string; created_at: Date; locale: string; deleted_at: Date | null;
  email_enc: Buffer | null; display_name_enc: Buffer | null;
}
interface ChildRow {
  id: string; parent_id: string; band: string; country: string; board: string;
  created_at: Date; deleted_at: Date | null; first_name_enc: Buffer | null;
  wrapped_dek: Buffer | null; kms_key_arn: string | null; shredded_at: Date | null;
  consent_status: string | null; memory_on: boolean | null; learn_on: boolean | null;
  sessions: number; live: number; messages: number; spine: number; locks: number;
  last_seen: Date | null; read_attempts: number; read_words: number; read_hits: number;
  memories: number; flags_open: number; flags_total: number;
}

/** Clamp a page number from a query string into range. Never throws. */
export function pageNumber(raw: string | undefined, pageCount: number): number {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, pageCount));
}

/**
 * Unwrap once per child, not once per field.
 *
 * A parent's email and their oldest child's first name are under the SAME DEK,
 * and with KMS every unwrap is a network call. Keyed by child id and alive for
 * one request only — a DEK cached across requests is a plaintext key sitting in
 * the heap of a long-lived process, which is a different security posture than
 * anyone signed up for.
 */
function dekCache(keys: KeyProvider) {
  const seen = new Map<string, Promise<Buffer | null>>();
  return (childId: string, wrapped: Buffer | null, keyRef: string | null) => {
    const hit = seen.get(childId);
    if (hit !== undefined) return hit;
    // A shredded key is zero bytes, and unwrapping it would throw. Erasure is
    // an ordinary state, not an error, so it resolves to null and the caller
    // renders "erased".
    const p: Promise<Buffer | null> =
      wrapped === null || keyRef === null || toBuffer(wrapped).length === 0
        ? Promise.resolve(null)
        : keys.unwrap(toBuffer(wrapped), keyRef).catch(() => null);
    seen.set(childId, p);
    return p;
  };
}

/**
 * Decrypt for display, and never let a bad blob take the page down.
 *
 * A row whose ciphertext does not authenticate is a real possibility after a
 * key rotation or a partial restore, and the right answer is one unreadable
 * cell rather than a 500 that hides twenty-four readable families.
 */
function reveal(blob: Buffer | null, dek: Buffer | null): string | null {
  if (blob === null || dek === null) return null;
  try { return decrypt(toBuffer(blob), dek); } catch { return null; }
}

export async function readUsers(
  pool: DbPool, keys: KeyProvider, rawPage: string | undefined,
): Promise<UsersView> {
  const totalsRow = (await pool.query<UserTotals & {
    consent_active: number; consent_pending: number; consent_revoked: number;
    sessions_live: number; crisis_locks: number; locks_open: number;
    flags_open: number; active_today: number;
  }>(TOTALS_SQL)).rows[0]!;

  const totals: UserTotals = {
    parents: totalsRow.parents, children: totalsRow.children,
    consentActive: totalsRow.consent_active,
    consentPending: totalsRow.consent_pending,
    consentRevoked: totalsRow.consent_revoked,
    sessions: totalsRow.sessions, sessionsLive: totalsRow.sessions_live,
    messages: totalsRow.messages, spine: totalsRow.spine,
    crisisLocks: totalsRow.crisis_locks, locksOpen: totalsRow.locks_open,
    flagsOpen: totalsRow.flags_open, memories: totalsRow.memories,
    activeToday: totalsRow.active_today,
  };

  const pageCount = Math.max(1, Math.ceil(totals.parents / PER_PAGE));
  const page = pageNumber(rawPage, pageCount);

  const parentRows = (await pool.query<ParentRow>(
    PARENTS_SQL, [PER_PAGE, (page - 1) * PER_PAGE])).rows;

  // No parents on this page means no ids to look children up by, and
  // `= ANY('{}')` is a wasted round trip that returns nothing.
  const childRows = parentRows.length === 0 ? [] : (await pool.query<ChildRow>(
    CHILDREN_SQL, [parentRows.map((p) => p.id)])).rows;

  // Every DEK on the page, in parallel. Sequential awaits inside the loop below
  // would make a 25-family page 25 round trips to KMS one after another.
  const dekFor = dekCache(keys);
  const deks = new Map<string, Buffer | null>(await Promise.all(
    childRows.map(async (r) => [
      r.id, await dekFor(r.id, r.wrapped_dek, r.kms_key_arn),
    ] as const)));

  const byParent = new Map<string, UserChild[]>();
  for (const r of childRows) {
    const dek = deks.get(r.id) ?? null;
    const kid: UserChild = {
      id: r.id, parentId: r.parent_id,
      firstName: reveal(r.first_name_enc, dek),
      band: r.band, country: r.country,
      board: r.board, createdAt: r.created_at, erased: r.deleted_at !== null,
      consentStatus: r.consent_status, memoryOn: r.memory_on, learnOn: r.learn_on,
      sessions: r.sessions, live: r.live, messages: r.messages, spine: r.spine,
      locks: r.locks, lastSeen: r.last_seen,
      readAttempts: r.read_attempts, readWords: r.read_words, readHits: r.read_hits,
      memories: r.memories, flagsOpen: r.flags_open, flagsTotal: r.flags_total,
    };
    const list = byParent.get(r.parent_id);
    if (list === undefined) byParent.set(r.parent_id, [kid]); else list.push(kid);
  }

  const parents = parentRows.map((p): UserParent => {
    const children = byParent.get(p.id) ?? [];
    let sessions = 0, messages = 0, locks = 0, flagsOpen = 0, memories = 0;
    let lastSeen: Date | null = null;
    for (const k of children) {
      sessions += k.sessions; messages += k.messages; locks += k.locks;
      flagsOpen += k.flagsOpen; memories += k.memories;
      if (k.lastSeen !== null && (lastSeen === null || k.lastSeen > lastSeen)) {
        lastSeen = k.lastSeen;
      }
    }
    // `children` is ordered oldest-first by CHILDREN_SQL, and the oldest child's
    // DEK is the one `createDraft` encrypted the parent's email under. Not
    // "any child's" — the wrong DEK does not decrypt to nonsense, it fails the
    // GCM auth tag and `reveal` returns null, so this ordering IS the lookup.
    const eldest = children[0];
    const parentDek = eldest === undefined ? null : deks.get(eldest.id) ?? null;
    return {
      id: p.id, createdAt: p.created_at, locale: p.locale,
      erased: p.deleted_at !== null,
      name: reveal(p.display_name_enc, parentDek),
      email: reveal(p.email_enc, parentDek),
      children, sessions, messages, locks, flagsOpen, memories, lastSeen,
    };
  });

  return { totals, parents, page, pageCount };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A refusal an operator should read, not a stack trace.
 *
 * Everything thrown from here is shaped for the console. The ops error handler
 * deliberately does NOT echo arbitrary error messages — `/ops/signals` learned
 * that the hard way when a k-anonymity refusal handed a browser the exact count
 * the floor exists to withhold — so anything an operator needs to see has to be
 * a type the route recognises rather than a message it forwards blindly.
 */
export class OpsRefused extends Error {
  constructor(message: string) { super(message); this.name = 'OpsRefused'; }
}

/**
 * The audit row. Takes `actor` from the caller, and every caller takes it from
 * the SESSION — there is no parameter here a form field reaches. Same rule as
 * `provider_cell.changed_by` and `training_example.authored_by`, and the same
 * reason: this is the field an incident review reads.
 */
async function record(tx: Db, entry: {
  actor: string; action: string; subject: 'parent' | 'child';
  subjectId: string; fields: readonly string[]; reason: string;
}): Promise<void> {
  await tx.query(
    `INSERT INTO ops_action (actor, action, subject, subject_id, fields, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entry.actor, entry.action, entry.subject, entry.subjectId,
      entry.fields, entry.reason]);
}

/** Every write takes one of these, and the route fills it from the session. */
export interface OpsWrite {
  readonly actor: string;
  readonly reason: string;
}

function checkReason(reason: string): void {
  if (reason.trim().length < 8) {
    throw new OpsRefused('Give a reason — this is the field an incident review reads.');
  }
}

/**
 * A key that will not open is an ORDINARY STATE on the write path too.
 *
 * The read path already treats it that way — `dekCache` catches and the cell
 * renders a dash — but the writes called `keys.unwrap` bare, so an unopenable
 * key produced a 500 and the console's generic "something went wrong" page.
 * Found by driving an edit against a family enrolled under a previous boot's
 * ephemeral dev master key, which is a laptop-only cause with production-real
 * equivalents: a CMK whose policy changed, a restore into an account that
 * cannot decrypt, a `kms_key_arn` pointing somewhere retired.
 *
 * An operator seeing "something went wrong" retries. An operator told the key
 * will not open stops and escalates, which is the correct next action, so the
 * failure is named rather than swallowed. It is still logged in full — the
 * refusal carries no key material, no id and no count.
 */
async function unwrapOrNull(
  keys: KeyProvider, wrapped: Buffer, keyRef: string,
): Promise<Buffer | null> {
  try { return await keys.unwrap(toBuffer(wrapped), keyRef); } catch { return null; }
}

/** The one sentence every write uses when a record's key will not open. */
const KEY_WILL_NOT_OPEN =
  'This record’s encryption key cannot be opened, so it cannot be edited. That is a '
  + 'key-management problem rather than a data one — check the CMK this deployment is '
  + 'configured with before trying again.';

/**
 * The DEK a parent's fields are encrypted under: their oldest child's.
 *
 * @returns null when there is no child, its key has been shredded, or the key
 *   cannot be unwrapped. All three mean the parent's name and email can no
 *   longer be written OR read, and the caller must say so rather than writing a
 *   blob nothing can open.
 */
async function parentDek(
  tx: Db, keys: KeyProvider, parentId: string,
): Promise<Buffer | null> {
  const r = await tx.query<{ wrapped_dek: Buffer; kms_key_arn: string }>(
    `SELECT k.wrapped_dek, k.kms_key_arn
       FROM child c JOIN child_data_key k ON k.child_id = c.id
      WHERE c.parent_id = $1 AND k.shredded_at IS NULL
      ORDER BY c.created_at ASC, c.id ASC LIMIT 1`, [parentId]);
  const row = r.rows[0];
  if (!row || toBuffer(row.wrapped_dek).length === 0) return null;
  return unwrapOrNull(keys, row.wrapped_dek, row.kms_key_arn);
}

export interface ParentEdit {
  readonly parentId: string;
  readonly name: string;
  readonly email: string;
  readonly locale: string;
}

/**
 * Correct a parent's name, email or locale.
 *
 * THE EMAIL IS TWO WRITES THAT MUST AGREE. `email_enc` is what a human reads
 * and `email_hash` is the blind index every lookup goes through, so updating
 * one without the other makes a parent unfindable by their own address — the
 * quiet failure `toJurisdiction` and `parseClassifier` are both about. They are
 * written in one statement.
 *
 * The UNIQUE on `email_hash` is what stops two families sharing an address, and
 * hitting it is an ordinary operator mistake rather than a bug: caught, and
 * turned into a sentence.
 */
export async function editParent(
  pool: DbPool, keys: KeyProvider, edit: ParentEdit, by: OpsWrite,
): Promise<void> {
  checkReason(by.reason);
  const name = edit.name.trim();
  const email = edit.email.trim();
  if (name === '') throw new OpsRefused('A parent needs a name.');
  // Deliberately loose. The strict check happened at enrolment; this is a
  // correction, and refusing a valid-but-unusual address here would leave an
  // operator unable to fix the very typo they were asked to fix.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new OpsRefused(`"${email}" is not an email address.`);
  }
  if (!/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(edit.locale)) {
    throw new OpsRefused(`"${edit.locale}" is not a locale.`);
  }

  await pool.transaction(async (tx) => {
    // null covers three cases and the operator needs to tell them apart: no
    // child at all, a shredded key, and a key that exists but will not open.
    const dek = await parentDek(tx, keys, edit.parentId);
    if (dek === null) {
      const anyLive = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM child c JOIN child_data_key k ON k.child_id = c.id
          WHERE c.parent_id = $1 AND k.shredded_at IS NULL
            AND octet_length(k.wrapped_dek) > 0`, [edit.parentId])).rows[0]?.n ?? 0;
      if (anyLive > 0) throw new OpsRefused(KEY_WILL_NOT_OPEN);
      throw new OpsRefused(
        'This parent has no child with a live key, so their name and email cannot '
        + 'be re-encrypted. Erasing the first child shreds the key the parent’s '
        + 'own details were stored under.');
    }
    const indexKey = await keys.indexKey();
    try {
      const r = await tx.query(
        `UPDATE parent
            SET display_name_enc = $2, email_enc = $3, email_hash = $4, locale = $5
          WHERE id = $1 AND deleted_at IS NULL`,
        [edit.parentId, encrypt(name, dek), encrypt(email, dek),
          fingerprint(email, indexKey), edit.locale]);
      if ((r as { rowCount?: number }).rowCount === 0) {
        // rowCount is not on the port's QueryResult, so this is advisory: a
        // driver that does not report it falls through and the audit records an
        // edit that changed nothing, which is honest either way.
        throw new OpsRefused('No such parent, or it has been erased.');
      }
    } catch (e) {
      if (e instanceof OpsRefused) throw e;
      if (/duplicate key|unique/i.test(String((e as Error).message))) {
        throw new OpsRefused('Another family already uses that email address.');
      }
      throw e;
    }
    await record(tx, {
      actor: by.actor, action: 'EDIT_PARENT', subject: 'parent',
      subjectId: edit.parentId, fields: ['display_name', 'email', 'locale'],
      reason: by.reason.trim(),
    });
  });
}

export interface ChildEdit {
  readonly childId: string;
  readonly firstName: string;
  readonly band: string;
  readonly board: string;
}

/**
 * Correct a child's name, band or board — by writing the consent version that
 * correction requires.
 *
 * ALL THREE ARE SEALED FIELDS, and that is the thing this function exists to
 * get right. `canonicalise` in @chittu/pedagogy's sibling — `packages/consent`
 * — hashes `childFirstName`, `band`, `board` and `country` into `seal_hash`,
 * and `assertActiveConsent` refuses a record whose seal does not verify. So
 * changing ANY of them and leaving the ledger alone does not produce a
 * mismatched-looking record; it produces a family that cannot open a session,
 * with `{"active": false}` and no way back, because there is no parent
 * re-login. The first version of this file versioned the ledger for a band
 * change and not for a name, and copied the OLD seal onto the NEW row. Both
 * were wrong, and both were found by driving the console against a running
 * API rather than by a test.
 *
 * SO THE SEAL IS RECOMPUTED, NEVER COPIED. `supersede()` from the consent
 * package is the only thing here that mints a seal, because the seal covers
 * fields this module does not own and a hand-rolled `INSERT ... SELECT
 * seal_hash` cannot know that.
 *
 * COUNTRY IS NOT EDITABLE, deliberately. `law` is chosen FROM the country at
 * enrolment, so moving a family between jurisdictions from a console would
 * leave a record claiming consent under a law that does not apply to them.
 * That is a re-consent, and it belongs in the consent flow.
 *
 * THE BEARER TOKEN MOVES TO THE NEW VERSION. `findByToken` reads `token_hash`
 * off the ACTIVE row, so leaving it behind signs the family out.
 * `token_only_when_active` forces the order: clear the token, change the
 * status, then insert the new row holding it.
 */
export async function editChild(
  pool: DbPool, keys: KeyProvider, edit: ChildEdit, by: OpsWrite,
): Promise<void> {
  checkReason(by.reason);
  const firstName = edit.firstName.trim();
  if (firstName === '') throw new OpsRefused('A child needs a first name.');
  if (firstName.length > 40) throw new OpsRefused('A first name is at most 40 characters.');
  if (!(BANDS as readonly string[]).includes(edit.band)) {
    throw new OpsRefused(`"${edit.band}" is not a band.`);
  }
  const board = edit.board.trim();
  if (board === '' || board.length > 60) {
    throw new OpsRefused('Give a board, up to 60 characters.');
  }

  const consent = consentRepo(pool, keys);

  await pool.transaction(async (tx) => {
    const cur = (await tx.query<{
      band: string; board: string;
      wrapped_dek: Buffer | null; kms_key_arn: string | null; shredded_at: Date | null;
    }>(
      `SELECT c.band::text AS band, c.board,
              k.wrapped_dek, k.kms_key_arn, k.shredded_at
         FROM child c LEFT JOIN child_data_key k ON k.child_id = c.id
        WHERE c.id = $1 AND c.deleted_at IS NULL`, [edit.childId])).rows[0];
    if (!cur) throw new OpsRefused('No such child, or it has been erased.');
    if (cur.shredded_at !== null || cur.wrapped_dek === null
      || toBuffer(cur.wrapped_dek).length === 0 || cur.kms_key_arn === null) {
      throw new OpsRefused('This child’s key has been shredded; the record cannot be edited.');
    }
    const dek = await unwrapOrNull(keys, cur.wrapped_dek, cur.kms_key_arn);
    if (dek === null) throw new OpsRefused(KEY_WILL_NOT_OPEN);
    const bandMoved = cur.band !== edit.band;

    await tx.query(
      `UPDATE child
          SET first_name_enc = $2, band = $3, board = $4,
              band_set_at = CASE WHEN $5 THEN now() ELSE band_set_at END
        WHERE id = $1`,
      [edit.childId, encrypt(firstName, dek), edit.band as Band, board, bandMoved]);

    const active = (await tx.query<{
      id: string; token_hash: Buffer | null; token_issued_at: Date | null;
    }>(`SELECT id, token_hash, token_issued_at FROM consent_record
         WHERE child_id = $1 AND status = 'active'`, [edit.childId])).rows[0];

    if (active) {
      // `tx`, not `pool`. Reading the record this transaction is about to
      // supersede from outside the transaction is the mistake CLAUDE.md says
      // has already been made twice here.
      const stored = await consent.byId(tx, active.id);
      if (!stored) throw new OpsRefused('That consent record could not be read.');

      const { previous, next } = supersede(stored.record, {
        band: edit.band as Band, board, childFirstName: firstName,
      });

      // Clear the token BEFORE the status change: token_only_when_active is a
      // CHECK, and it fires on the UPDATE that moves the row off 'active'.
      await tx.query(
        `UPDATE consent_record SET token_hash = NULL, token_issued_at = NULL
          WHERE id = $1`, [active.id]);
      await tx.query(
        `UPDATE consent_record SET status = 'superseded', seal_hash = $2 WHERE id = $1`,
        [active.id, previous.sealHash]);

      await tx.query(
        `INSERT INTO consent_record
           (id, parent_id, child_id, version, supersedes, jurisdiction, law, method,
            status, scopes, memory_on, learn_on, band, board, issued_at,
            expires_at, seal_hash, token_hash, token_issued_at, created_at)
         SELECT $2, parent_id, child_id, $3, id, jurisdiction, law, method,
                'active', $4::jsonb, memory_on, learn_on, $5, $6, issued_at,
                expires_at, $7, $8, $9, $10
           FROM consent_record WHERE id = $1`,
        [active.id, next.id, next.version, JSON.stringify(next.scopes),
          next.band as Band, next.board, next.sealHash,
          active.token_hash, active.token_issued_at, next.createdAt]);
    }

    await record(tx, {
      actor: by.actor, action: 'EDIT_CHILD', subject: 'child',
      subjectId: edit.childId, fields: ['first_name', 'band', 'board'],
      reason: by.reason.trim(),
    });
  });
}

/**
 * Erase a child: revoke the consent and shred the key.
 *
 * THIS IS THE SAME PRIMITIVE THE PARENT'S OWN ERASE USES — `revoke_and_erase`,
 * which shreds the DEK, drops the plaintext-bearing rows and closes the seal,
 * leaving the consent ledger standing as proof a consent existed and was
 * withdrawn. It is not a soft delete and there is no undo: the key is gone, so
 * the ciphertext is gone with it.
 *
 * IT IS ALSO A REAL WIDENING OF WHO CAN DO IT. `DELETE /v1/consent` requires a
 * live parent session, which only a correct PIN mints — "a child holds one of
 * those" is the reason it is written that way. An operator with a bearer token
 * now has the same power. What that buys is a support path for a family who
 * cannot reach their own PIN; what it costs is that the parent gate is no
 * longer the only door. The mitigations are the ones available: the console
 * does not exist unless operators are configured, the action needs a typed
 * confirmation and a written reason, and the row in `ops_action` carries the
 * operator's name from their token rather than from anything they typed.
 *
 * The audit row outlives the child it names, which is the correct residue:
 * proof an erasure happened, and nothing about who it was.
 */
export async function eraseChild(
  pool: DbPool, childId: string, by: OpsWrite,
): Promise<{ sessionsEnded: number }> {
  checkReason(by.reason);

  const target = (await pool.query<{ consent_id: string | null }>(
    `SELECT (SELECT id FROM consent_record
              WHERE child_id = c.id AND status = 'active') AS consent_id
       FROM child c WHERE c.id = $1 AND c.deleted_at IS NULL`, [childId])).rows[0];
  if (!target) throw new OpsRefused('No such child, or it has already been erased.');

  const live = (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM session
      WHERE child_id = $1 AND ended_at IS NULL`, [childId])).rows[0]?.n ?? 0;

  await pool.transaction(async (tx) => {
    // revoke_and_erase RAISES unless the scope is set and matches — a silent
    // no-op on an erasure request is the worst failure this system has, and the
    // function refuses to be the one that produces it.
    await tx.query('SELECT set_config($1, $2, true)', ['chittu.child_id', childId]);
    if (target.consent_id !== null) {
      await tx.query(
        `UPDATE consent_record SET token_hash = NULL, token_issued_at = NULL
          WHERE id = $1`, [target.consent_id]);
    }
    await tx.query('SELECT revoke_and_erase($1, $2)', [childId, `ops: ${by.reason.trim()}`]);
    await record(tx, {
      actor: by.actor, action: 'ERASE_CHILD', subject: 'child',
      subjectId: childId, fields: [], reason: by.reason.trim(),
    });
  });
  return { sessionsEnded: live };
}

export interface OpsActionRow {
  readonly actor: string;
  readonly action: string;
  readonly subject: string;
  readonly subjectId: string;
  readonly fields: readonly string[];
  readonly reason: string;
  readonly createdAt: Date;
}

/** The last fifty ops actions, newest first. Shown under the table. */
export async function readActions(pool: DbPool): Promise<readonly OpsActionRow[]> {
  const { rows } = await pool.query<{
    actor: string; action: string; subject: string; subject_id: string;
    fields: string[]; reason: string; created_at: Date;
  }>(`SELECT actor, action, subject, subject_id, fields, reason, created_at
        FROM ops_action ORDER BY created_at DESC, id DESC LIMIT 50`);
  return rows.map((r) => ({
    actor: r.actor, action: r.action, subject: r.subject, subjectId: r.subject_id,
    fields: r.fields, reason: r.reason, createdAt: r.created_at,
  }));
}
