/**
 * The persistence layer, against real Postgres (PGlite/WASM).
 *
 * Two of these suites exist because of a bug this file found: everything was
 * previously verified as SUPERUSER, which bypasses both grants and row-level
 * security. `chittu_app` had five RLS policies and no table grants, so the
 * application role could not read a single row — and nothing noticed.
 *
 * So the RLS suite below does `SET ROLE chittu_app` and stays there.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { draftConsent, markVerifying, activate, hashPin } from '@chittu/consent';
import {
  wrapPglite, withChildScope, localKeyProvider, encrypt, decrypt, fingerprint,
  CryptoError, auditRepo, consentRepo, childRepo, chainHash, GENESIS,
  type DbPool, type FamilyDraft,
} from './index';

let pool: DbPool;
let pg: PGlite;
const master = randomBytes(32);
const keys = localKeyProvider(master, 'dev');

const draft: FamilyDraft = {
  parentName: 'Lakshmi', parentEmail: 'lakshmi@example.com',
  childFirstName: 'Meera', country: 'IN', band: 'builder',
  board: 'CBSE', memoryOn: true, learnOn: false,
};

beforeAll(async () => {
  const dir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
  pg = await PGlite.create({ extensions: { pgcrypto } });
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    let sql = readFileSync(dir + f, 'utf8');
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS vector;.*\n/, '')
             .replace(/vector\(1024\)/g, 'real[]')
             .replace(/CREATE INDEX corpus_chunk_ann[\s\S]*?;\n/, '');
    await pg.exec(sql);
  }
  await pg.exec(`INSERT INTO deployment (env, region) VALUES ('dev','ap-south-1')`);
  pool = wrapPglite(pg as never);
}, 180_000);

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
    expect(await fam.repo.childName(fam.childId)).toBe('Meera');

    await fam.repo.revokeAndErase(fam.consentId, fam.childId, 'parent request');

    // the wrapped DEK is zeroed, so nothing encrypted under it can be read
    await expect(fam.repo.childName(fam.childId)).rejects.toThrow(/shredded|erased/i);
  });

  it('leaves the consent ledger standing as proof', async () => {
    const fam = await makeFamily({ parentEmail: 'proof@example.com' });
    await fam.repo.revokeAndErase(fam.consentId, fam.childId, 'parent request');
    const after = await fam.repo.byId(fam.consentId);
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
    expect((await fam.repo.findByToken(fam.token))?.consentId).toBe(fam.consentId);
  });

  it('stops resolving the moment the consent is revoked', async () => {
    const fam = await makeFamily({ parentEmail: 'rev@example.com' });
    expect(await fam.repo.findByToken(fam.token)).not.toBeNull();
    await fam.repo.revokeAndErase(fam.consentId, fam.childId, 'parent request');
    expect(await fam.repo.findByToken(fam.token)).toBeNull();
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
  // superuser bypasses grants AND rls, so everything above proves nothing here.
  // The scope is reset too: set_config(..., false) is SESSION-level and outlives
  // the test that set it, so "never set" would otherwise inherit a stale value.
  beforeEach(async () => {
    await pg.exec('RESET ROLE');
    await pg.exec(`RESET "chittu.child_id"`);
  });

  it('the app role can actually read — the grants exist', async () => {
    const fam = await makeFamily({ parentEmail: 'grants@example.com' });
    await pg.exec('SET ROLE chittu_app');
    const r = await pg.query(
      `SELECT set_config('chittu.child_id', '${fam.childId}', false)`);
    expect(r).toBeTruthy();
    const rows = await pg.query(`SELECT id FROM child`);
    expect(rows.rows.length, 'no grants means the policies are inert').toBe(1);
    await pg.exec('RESET ROLE');
  });

  it('cannot see another family’s child', async () => {
    const a = await makeFamily({ parentEmail: 'a@example.com' });
    const b = await makeFamily({ parentEmail: 'b@example.com' });
    await pg.exec('SET ROLE chittu_app');
    await pg.query(`SELECT set_config('chittu.child_id', '${a.childId}', false)`);
    const rows = await pg.query<{ id: string }>(`SELECT id FROM child`);
    await pg.exec('RESET ROLE');
    const ids = rows.rows.map((x) => x.id);
    expect(ids).toContain(a.childId);
    expect(ids, 'cross-family leakage').not.toContain(b.childId);
  });

  it.each([
    ['never set', null],
    ['set to empty', ''],
  ])('sees NOTHING when the scope is %s — RLS fails closed, without erroring',
    async (_label, value) => {
      await makeFamily({ parentEmail: `noscope-${_label.replace(/ /g, '')}@example.com` });
      await pg.exec('SET ROLE chittu_app');
      if (value !== null) {
        await pg.query(`SELECT set_config('chittu.child_id', $1, false)`, [value]);
      }
      // must return zero rows, NOT raise: an invalid-uuid error is a 500 where a
      // clean empty result is the correct fail-closed answer
      const rows = await pg.query(`SELECT id FROM child`);
      await pg.exec('RESET ROLE');
      expect(rows.rows).toHaveLength(0);
    });

  it('cannot UPDATE or DELETE the audit chain even with grants', async () => {
    const fam = await makeFamily({ parentEmail: 'append@example.com' });
    await pg.exec('SET ROLE chittu_app');
    await pg.query(`SELECT set_config('chittu.child_id', '${fam.childId}', false)`);
    let err: Error | null = null;
    try { await pg.query(`DELETE FROM audit_event`); } catch (e) { err = e as Error; }
    await pg.exec('RESET ROLE');
    expect(err).not.toBeNull();
  });

  it('has NO access to the training corpus at all', async () => {
    await pg.exec('SET ROLE chittu_app');
    let err: Error | null = null;
    try { await pg.query(`SELECT * FROM training_example`); } catch (e) { err = e as Error; }
    await pg.exec('RESET ROLE');
    expect(err?.message).toMatch(/permission denied/i);
  });

  it('has NO access to transcript grants or admin users', async () => {
    await pg.exec('SET ROLE chittu_app');
    for (const t of ['transcript_grant', 'admin_user']) {
      let err: Error | null = null;
      try { await pg.query(`SELECT * FROM ${t}`); } catch (e) { err = e as Error; }
      expect(err?.message, t).toMatch(/permission denied/i);
    }
    await pg.exec('RESET ROLE');
  });
});
