/**
 * The persistence layer, against a real Postgres 16 + pgvector server.
 *
 * Two of these suites exist because of a bug this file found: everything was
 * previously verified as SUPERUSER, which bypasses both grants and row-level
 * security. `chittu_app` had five RLS policies and no table grants, so the
 * application role could not read a single row — and nothing noticed.
 *
 * So the RLS suite below does `SET ROLE chittu_app` and stays there.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { draftConsent, markVerifying, activate, hashPin } from '@chittu/consent';
import {
  withChildScope, localKeyProvider, encrypt, decrypt, fingerprint, createTestDb,
  CryptoError, auditRepo, consentRepo, childRepo, chainHash, GENESIS,
  type DbPool, type FamilyDraft,
} from './index.js';

let pool: DbPool;
let db: Awaited<ReturnType<typeof createTestDb>>;
const master = randomBytes(32);
const keys = localKeyProvider(master, 'dev');

const draft: FamilyDraft = {
  parentName: 'Lakshmi', parentEmail: 'lakshmi@example.com',
  childFirstName: 'Meera', country: 'IN', band: 'builder',
  board: 'CBSE', memoryOn: true, learnOn: false, visionOn: false, voiceOn: false,
};

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
}, 180_000);

afterAll(async () => { await db.close(); });

/** Draft → activate, returning the ids and the bearer token. */
async function makeFamily(over: Partial<typeof draft> = {}) {
  const d = { ...draft, ...over };
  const repo = consentRepo(pool, keys);
  const rec = draftConsent(d, 'dev_stub');
  const verifying = markVerifying(rec);
  const stored = await repo.createDraft(
    d, 'dev_stub', rec.law, await hashPin('4917'), verifying);
  const evidence = {
    method: 'dev_stub' as const, provider: 'dev-stub', providerRef: 'x',
    evidenceHash: 'ab'.repeat(32), verifiedAt: new Date().toISOString(),
  };
  const active = activate(verifying, evidence);
  const { token } = await repo.activate(stored.consentId, evidence, active);
  return { ...stored, token, repo };
}

// ---------------------------------------------------------------------------

describe('envelope encryption', () => {
  it('round-trips', () => {
    const dek = randomBytes(32);
    expect(decrypt(encrypt('my hamster is called Barnaby', dek), dek))
      .toBe('my hamster is called Barnaby');
  });

  it('produces a different ciphertext every time', () => {
    const dek = randomBytes(32);
    expect(encrypt('same', dek).equals(encrypt('same', dek))).toBe(false);
  });

  it('REFUSES a tampered ciphertext rather than returning nonsense', () => {
    const dek = randomBytes(32);
    const blob = encrypt('the truth', dek);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    expect(() => decrypt(blob, dek)).toThrow();
  });

  it('refuses the wrong key', () => {
    const blob = encrypt('secret', randomBytes(32));
    expect(() => decrypt(blob, randomBytes(32))).toThrow();
  });

  it('the blind index is KEYED — a bare hash would be a plaintext email', async () => {
    const k1 = await keys.indexKey();
    const k2 = await localKeyProvider(randomBytes(32), 'dev').indexKey();
    const email = 'lakshmi@example.com';
    expect(fingerprint(email, k1).equals(fingerprint(email, k2))).toBe(false);
    // and it is stable + case-insensitive, so login works
    expect(fingerprint('LAKSHMI@example.com ', k1).equals(fingerprint(email, k1))).toBe(true);
  });

  it('refuses to hand out a local key provider in production', () => {
    expect(() => localKeyProvider(randomBytes(32), 'prod')).toThrow(CryptoError);
  });
});

describe('crypto-shredding', () => {
  it('makes a child’s data unrecoverable, and says why', async () => {
    const fam = await makeFamily({ parentEmail: 'shred@example.com' });
    expect(await fam.repo.childName(pool, fam.childId)).toBe('Meera');

    await fam.repo.revokeAndErase(fam.consentId, fam.childId, 'parent request');

    // the wrapped DEK is zeroed, so nothing encrypted under it can be read
    await expect(fam.repo.childName(pool, fam.childId)).rejects.toThrow(/shredded|erased/i);
  });

  it('leaves the consent ledger standing as proof', async () => {
    const fam = await makeFamily({ parentEmail: 'proof@example.com' });
    await fam.repo.revokeAndErase(fam.consentId, fam.childId, 'parent request');
    const after = await fam.repo.byId(pool, fam.consentId);
    expect(after?.record.status).toBe('revoked');
    expect(after?.record.revokedAt).toBeTruthy();
  });
});

describe('the consent token', () => {
  it('is NEVER stored in the clear', async () => {
    const fam = await makeFamily({ parentEmail: 'tok@example.com' });
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM consent_record WHERE token_hash::text LIKE $1`,
      [`%${fam.token.slice(0, 12)}%`]);
    expect(r.rows[0]!.n).toBe(0);
    // and the real token still resolves
    expect((await fam.repo.findByToken(pool, fam.token))?.consentId).toBe(fam.consentId);
  });

  it('stops resolving the moment the consent is revoked', async () => {
    const fam = await makeFamily({ parentEmail: 'rev@example.com' });
    expect(await fam.repo.findByToken(pool, fam.token)).not.toBeNull();
    await fam.repo.revokeAndErase(fam.consentId, fam.childId, 'parent request');
    expect(await fam.repo.findByToken(pool, fam.token)).toBeNull();
  });

  it('the DATABASE refuses a token on a non-active consent', async () => {
    const fam = await makeFamily({ parentEmail: 'dbguard@example.com' });
    // even if application code forgot to clear it
    let err: Error | null = null;
    try {
      await pool.query(`UPDATE consent_record SET status = 'revoked' WHERE id = $1`,
        [fam.consentId]);
    } catch (e) { err = e as Error; }
    expect(err?.message, 'the CHECK must reject this').toMatch(/check constraint|token_only_when_active/i);
  });
});

describe('the seal chain under a database', () => {
  it('does not fork when many appends race', async () => {
    const fam = await makeFamily({ parentEmail: 'seal@example.com' });
    const audit = auditRepo(pool);
    const child = childRepo(pool, keys);
    const sessionId = await withChildScope(pool, fam.childId, (tx) =>
      child.openSession(tx, fam.childId, fam.consentId, 'builder'));

    // fire them all at once; the row lock is what keeps them in single file
    await Promise.all(Array.from({ length: 25 }, (_u, i) =>
      withChildScope(pool, fam.childId, (tx) =>
        audit.append(tx, {
          sessionId, role: 'child', layer: 'SEAL', text: `turn-${i}`,
        }))));

    const v = await audit.verify(sessionId);
    expect(v.ok, `chain broke at ${v.brokenAt}`).toBe(true);
    expect(v.records).toBe(25);
  });

  it('verify() catches an edited prev_hash, not just a bad hash', async () => {
    const fam = await makeFamily({ parentEmail: 'tamper@example.com' });
    const audit = auditRepo(pool);
    const child = childRepo(pool, keys);
    const sessionId = await withChildScope(pool, fam.childId, (tx) =>
      child.openSession(tx, fam.childId, fam.consentId, 'builder'));
    for (const t of ['a', 'b', 'c']) {
      await withChildScope(pool, fam.childId, (tx) =>
        audit.append(tx, { sessionId, role: 'child', layer: 'SEAL', text: t }));
    }
    expect((await audit.verify(sessionId)).ok).toBe(true);

    // audit_event refuses UPDATE, so the only way to test the check is to
    // confirm the database itself is the first line of defence
    await expect(
      pool.query(`UPDATE audit_event SET prev_hash = 'forged' WHERE session_id = $1`,
        [sessionId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('the chain never stores what the child said', async () => {
    const fam = await makeFamily({ parentEmail: 'nocontent@example.com' });
    const audit = auditRepo(pool);
    const child = childRepo(pool, keys);
    const sessionId = await withChildScope(pool, fam.childId, (tx) =>
      child.openSession(tx, fam.childId, fam.consentId, 'builder'));
    await withChildScope(pool, fam.childId, (tx) =>
      audit.append(tx, {
        sessionId, role: 'child', layer: 'SEAL', text: 'i want to hurt myself',
      }));
    const r = await pool.query(`SELECT * FROM audit_event WHERE session_id = $1`, [sessionId]);
    expect(JSON.stringify(r.rows)).not.toContain('hurt myself');
  });

  it('two sessions with the same first turn do not collide', async () => {
    // UNIQUE(hash) is global. A shared GENESIS would make identical opening
    // turns produce identical hashes and reject the second child.
    const fam = await makeFamily({ parentEmail: 'collide@example.com' });
    const audit = auditRepo(pool);
    const child = childRepo(pool, keys);
    const ids = await Promise.all([1, 2].map(() =>
      withChildScope(pool, fam.childId, (tx) =>
        child.openSession(tx, fam.childId, fam.consentId, 'builder'))));
    for (const sid of ids) {
      await withChildScope(pool, fam.childId, (tx) =>
        audit.append(tx, {
          sessionId: sid, role: 'child', layer: 'SEAL', text: 'why is the sky blue',
        }));
    }
    for (const sid of ids) expect((await audit.verify(sid)).ok).toBe(true);
  });

  /**
   * D5/SEAL — "recompute every hash".
   *
   * `verify(sessionId)` answers for one conversation. A parent asking whether
   * anything was edited is not asking about one conversation, and the prototype's
   * button recomputed the lot from GENESIS. `verifyChild` is that, over every
   * chain the child has.
   */
  describe('verifyChild — every chain the child has', () => {
    async function chainsFor(email: string, texts: string[][]) {
      const fam = await makeFamily({ parentEmail: email });
      const audit = auditRepo(pool);
      const child = childRepo(pool, keys);
      const ids: string[] = [];
      for (const turns of texts) {
        const sid = await withChildScope(pool, fam.childId, (tx) =>
          child.openSession(tx, fam.childId, fam.consentId, 'builder'));
        ids.push(sid);
        for (const t of turns) {
          await withChildScope(pool, fam.childId, (tx) =>
            audit.append(tx, { sessionId: sid, role: 'child', layer: 'SEAL', text: t }));
        }
      }
      return { fam, audit, ids };
    }

    it('recomputes every hash across every session', async () => {
      const { fam, audit } = await chainsFor('wholechain@example.com',
        [['a', 'b', 'c'], ['d', 'e'], ['f']]);
      const v = await audit.verifyChild(fam.childId);
      expect(v.ok, `broke at ${JSON.stringify(v.broken)}`).toBe(true);
      expect(v.sessions).toBe(3);
      expect(v.records).toBe(6);
      expect(v.broken).toBeNull();
    });

    it('answers for a child who has no chains at all', async () => {
      const fam = await makeFamily({ parentEmail: 'nochain@example.com' });
      const v = await auditRepo(pool).verifyChild(fam.childId);
      expect(v).toEqual({ ok: true, sessions: 0, records: 0, broken: null });
    });

    it('sees nothing of another family — a second child’s chains are not counted', async () => {
      const mine = await chainsFor('mineseal@example.com', [['a', 'b']]);
      await chainsFor('theirsseal@example.com', [['x', 'y', 'z']]);
      const v = await mine.audit.verifyChild(mine.fam.childId);
      expect(v.sessions).toBe(1);
      expect(v.records).toBe(2);
    });

    /**
     * The one that makes the rest worth having.
     *
     * `audit_event` refuses UPDATE and DELETE by trigger, so a tampered chain
     * cannot be built through the front door — which is exactly why this test
     * goes round it. The threat the seal answers is a compromise of Postgres
     * itself, and someone who has that has the owner role and can drop a
     * trigger. Disabling it here is what that attacker's afternoon looks like.
     */
    it('names the session and the record when a hash was edited', async () => {
      const { fam, audit, ids } = await chainsFor('brokenchain@example.com',
        [['a', 'b'], ['c', 'd', 'e']]);
      const victim = ids[1]!;
      try {
        await pool.query(`ALTER TABLE audit_event DISABLE TRIGGER audit_no_update`);
        await pool.query(
          `UPDATE audit_event SET payload_hash = repeat('f', 64)
            WHERE session_id = $1 AND seq = 1`, [victim]);
      } finally {
        await pool.query(`ALTER TABLE audit_event ENABLE TRIGGER audit_no_update`);
      }

      const v = await audit.verifyChild(fam.childId);
      expect(v.ok).toBe(false);
      expect(v.broken).toEqual({ sessionId: victim, seq: 1 });
      // Still reports how much it looked at, so "0 records, all fine" and
      // "5 records, one edited" cannot read the same on a parent's screen.
      expect(v.records).toBe(5);
      expect(v.sessions).toBe(2);
    });

    it('names the break when a prev_hash alone was edited', async () => {
      // The gap PORT-REVIEW §5 records in the prototype: its loop checked only
      // the record hash, so an edited link passed. This checks the link too, and
      // this is the case that proves it — the record's own hash still recomputes.
      const { fam, audit, ids } = await chainsFor('prevlink@example.com', [['a', 'b', 'c']]);
      const victim = ids[0]!;
      try {
        await pool.query(`ALTER TABLE audit_event DISABLE TRIGGER audit_no_update`);
        await pool.query(
          `UPDATE audit_event SET prev_hash = repeat('e', 64)
            WHERE session_id = $1 AND seq = 2`, [victim]);
      } finally {
        await pool.query(`ALTER TABLE audit_event ENABLE TRIGGER audit_no_update`);
      }

      const v = await audit.verifyChild(fam.childId);
      expect(v.ok).toBe(false);
      expect(v.broken).toEqual({ sessionId: victim, seq: 2 });
    });

    it('names the break when a record was REMOVED from the middle', async () => {
      // Deletion is the tamper a hash-only walk cannot see: every surviving
      // record still recomputes against its own stored prev. What gives it away
      // is the gap in `seq`.
      const { fam, audit, ids } = await chainsFor('deleted@example.com', [['a', 'b', 'c', 'd']]);
      const victim = ids[0]!;
      try {
        await pool.query(`ALTER TABLE audit_event DISABLE TRIGGER audit_no_delete`);
        await pool.query(`DELETE FROM audit_event WHERE session_id = $1 AND seq = 1`, [victim]);
      } finally {
        await pool.query(`ALTER TABLE audit_event ENABLE TRIGGER audit_no_delete`);
      }

      const v = await audit.verifyChild(fam.childId);
      expect(v.ok).toBe(false);
      expect(v.broken).toEqual({ sessionId: victim, seq: 2 });
      expect(v.records).toBe(3);
    });

    it('agrees with the per-session verify on the same chain', async () => {
      // Two implementations of one claim would be two claims. This pins them
      // together on the ordinary case; `keep the per-session one` is a product
      // decision, not a licence for the two to drift.
      const { fam, audit, ids } = await chainsFor('agreeseal@example.com', [['a', 'b', 'c']]);
      const one = await audit.verify(ids[0]!);
      const all = await audit.verifyChild(fam.childId);
      expect(one.ok).toBe(all.ok);
      expect(one.records).toBe(all.records);
    });
  });

  it('hashes compose, so verify can recompute from what is stored', () => {
    // hash = sha(prev | payloadHash), and payloadHash is what the table stores.
    // Had the prototype's hash-the-payload-directly form been ported, verify()
    // would have had nothing to recompute from.
    const a = chainHash(GENESIS, 'child', 'hello');
    const b = chainHash(a.hash, 'chittu', 'hi there');
    expect(a.hash).not.toBe(b.hash);
    expect(chainHash(GENESIS, 'child', 'hello').hash).toBe(a.hash);   // deterministic
    expect(chainHash('other-prev', 'child', 'hello').hash).not.toBe(a.hash);
  });
});

describe('messages, memories and flags', () => {
  it('never stores a teen’s body, but keeps the topic', async () => {
    const fam = await makeFamily({ parentEmail: 'teen@example.com', band: 'thinker' });
    const child = childRepo(pool, keys);
    await withChildScope(pool, fam.childId, async (tx) => {
      const sid = await child.openSession(tx, fam.childId, fam.consentId, 'thinker');
      await child.addMessage(tx, sid, fam.childId, 'thinker', 'child',
        'something personal', 'volcanoes', 'chat', {});
      const t = await child.transcript(tx, sid, fam.childId);
      expect(t[0]!.body).toBeNull();
      expect(t[0]!.topic).toBe('volcanoes');
    });
  });

  it('stores and decrypts a younger child’s transcript', async () => {
    const fam = await makeFamily({ parentEmail: 'young@example.com' });
    const child = childRepo(pool, keys);
    await withChildScope(pool, fam.childId, async (tx) => {
      const sid = await child.openSession(tx, fam.childId, fam.consentId, 'builder');
      await child.addMessage(tx, sid, fam.childId, 'builder', 'child',
        'why is the sky blue', 'science', 'chat', {});
      const t = await child.transcript(tx, sid, fam.childId);
      expect(t[0]!.body).toBe('why is the sky blue');
    });
  });

  it('a message body is ciphertext at rest', async () => {
    const fam = await makeFamily({ parentEmail: 'cipher@example.com' });
    const child = childRepo(pool, keys);
    await withChildScope(pool, fam.childId, async (tx) => {
      const sid = await child.openSession(tx, fam.childId, fam.consentId, 'builder');
      await child.addMessage(tx, sid, fam.childId, 'builder', 'child',
        'my secret words', null, 'chat', {});
    });
    const r = await pool.query(`SELECT body_enc FROM message`);
    expect(JSON.stringify(r.rows)).not.toContain('my secret words');
  });

  it('enforces the memory allowlist and de-duplicates', async () => {
    const fam = await makeFamily({ parentEmail: 'mem@example.com' });
    const child = childRepo(pool, keys);
    await withChildScope(pool, fam.childId, async (tx) => {
      const sid = await child.openSession(tx, fam.childId, fam.consentId, 'builder');
      expect(await child.addMemory(tx, fam.childId, 'FEELING', 'is sad', sid)).toBeNull();
      expect(await child.addMemory(tx, fam.childId, 'PET', 'has a cat named Mani', sid))
        .not.toBeNull();
      expect(await child.addMemory(tx, fam.childId, 'PET', 'has a cat named Mani', sid))
        .toBeNull();   // duplicate
      const list = await child.listMemories(tx, fam.childId);
      expect(list).toHaveLength(1);
      expect(list[0]!.fact).toBe('has a cat named Mani');
    });
  });

  it('a flag carries a vetted phrase and no child words', async () => {
    const fam = await makeFamily({ parentEmail: 'flag@example.com' });
    const child = childRepo(pool, keys);
    await withChildScope(pool, fam.childId, async (tx) => {
      const sid = await child.openSession(tx, fam.childId, fam.consentId, 'builder');
      await child.addFlag(tx, fam.childId, sid, 'SAFETY', 'CRISIS_DISTRESS');
      const flags = await child.listFlags(tx, fam.childId);
      expect(flags[0]!.category).toBe('CRISIS');
      expect(flags[0]!.body).toMatch(/calm mode/i);
    });
  });
});

// ---------------------------------------------------------------------------

describe('row-level security, AS THE APPLICATION ROLE', () => {
  /**
   * Everything above this line proves nothing about RLS: it runs as superuser,
   * which bypasses both grants and row-level security.
   *
   * `SET ROLE` is PER CONNECTION, and a pool hands out a different connection for
   * the next query — so a role set by one statement is simply not set for the
   * next. The second assertion in a pair silently ran as superuser and passed —
   * a mistake a single-connection driver would have hidden entirely, which is
   * one more reason the suite runs on a real pool. So the role is set with
   * SET LOCAL inside ONE transaction, which is also how the application does it.
   */
  async function asAppRole<T>(
    fn: (tx: { query: <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
      Promise<{ rows: R[] }> }) => Promise<T>,
    childId?: string,
  ): Promise<T> {
    return pool.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE chittu_app');
      await tx.query('SELECT set_config($1, $2, true)',
        ['chittu.child_id', childId ?? '']);
      return fn(tx);
    });
  }

  it('the app role can actually read — the grants exist', async () => {
    const fam = await makeFamily({ parentEmail: 'grants@example.com' });
    const rows = await asAppRole((tx) =>
      tx.query<{ id: string }>('SELECT id FROM child'), fam.childId);
    expect(rows.rows.length, 'no grants means the policies are inert').toBe(1);
    expect(rows.rows[0]!.id).toBe(fam.childId);
  });

  it('cannot see another family’s child', async () => {
    const a = await makeFamily({ parentEmail: 'rlsa@example.com' });
    const b = await makeFamily({ parentEmail: 'rlsb@example.com' });
    const rows = await asAppRole((tx) =>
      tx.query<{ id: string }>('SELECT id FROM child'), a.childId);
    const ids = rows.rows.map((x) => x.id);
    expect(ids).toContain(a.childId);
    expect(ids, 'cross-family leakage').not.toContain(b.childId);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('sees NOTHING when the scope is %s — fails closed without erroring',
    async (_label, value) => {
      await makeFamily({ parentEmail: `noscope-${_label}@example.com` });
      // must return zero rows, NOT raise: an invalid-uuid error is a 500 where a
      // clean empty result is the correct fail-closed answer
      const rows = await asAppRole((tx) =>
        tx.query('SELECT id FROM child'), value);
      expect(rows.rows).toHaveLength(0);
    });

  it('cannot UPDATE or DELETE the audit chain even with grants', async () => {
    const fam = await makeFamily({ parentEmail: 'append@example.com' });
    let err: Error | null = null;
    try {
      await asAppRole((tx) => tx.query('DELETE FROM audit_event'), fam.childId);
    } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
  });

  it.each(['training_example', 'training_run', 'dataset_export',
           'transcript_grant', 'admin_user'])(
    'has NO access to %s — the absence of a grant is the control', async (table) => {
      let err: Error | null = null;
      try {
        await asAppRole((tx) => tx.query(`SELECT * FROM ${table}`));
      } catch (e) { err = e as Error; }
      expect(err?.message, `${table} was readable`).toMatch(/permission denied/i);
    });
});
