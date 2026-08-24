/**
 * What the seal chain actually proves, demonstrated rather than asserted.
 *
 * PORT-REVIEW §5 says "a record whose `prev` field alone is edited still
 * verifies as OK", which is true and reads worse than it is. `verifyRecords`
 * recomputes from a RUNNING hash seeded at GENESIS, so the links are checked —
 * just not via the stored `prev` field. Content edits, deletions and reorderings
 * are all caught. What is genuinely uncovered is narrower and more specific, and
 * this file pins each case so the decision in §5 is made against facts.
 *
 * These tests DOCUMENT CURRENT BEHAVIOUR. The ones marked "GAP" pass today by
 * describing something the chain does not detect. If someone strengthens the
 * seal, they should fail — that is the point, and the reason each says so.
 */
import { describe, it, expect } from 'vitest';
import { createChain, verifyRecords, GENESIS, sha, HASH_HEX_LENGTH,
  type SealRecord } from './index.js';

async function chainOf(...texts: string[]) {
  const c = createChain();
  for (const text of texts) await c.append({ role: 'child', layer: 'INPUT', text });
  return c;
}

describe('what the chain DOES catch', () => {
  it('an edited message', async () => {
    const c = await chainOf('one', 'two', 'three');
    const tampered = c.records().map((r, i) =>
      i === 1 ? { ...r, payload: 'child|TWO EDITED' } : r);
    expect(verifyRecords(tampered)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('a deleted record in the middle — the running hash diverges', async () => {
    const c = await chainOf('one', 'two', 'three');
    const withHole = c.records().filter((_, i) => i !== 1);
    expect(verifyRecords(withHole).ok).toBe(false);
  });

  it('two records swapped', async () => {
    const c = await chainOf('one', 'two', 'three');
    const r = [...c.records()];
    [r[0], r[1]] = [r[1]!, r[0]!];
    expect(verifyRecords(r).ok).toBe(false);
  });

  it('a record appended by someone who does not know the head', async () => {
    const c = await chainOf('one', 'two');
    const forged: SealRecord = {
      t: new Date().toISOString(), role: 'chittu', layer: 'RENDER',
      payload: 'chittu|i never said this',
      prev: c.head(),
      h: sha('WRONG PREV|chittu|i never said this'),
    };
    expect(verifyRecords([...c.records(), forged]).ok).toBe(false);
  });
});

describe('GAP — what the chain does NOT catch (PORT-REVIEW §5)', () => {
  it('GAP: the timestamp is outside the hash, so `t` can be rewritten freely', async () => {
    const c = await chainOf('one', 'two');
    const backdated = c.records().map((r, i) =>
      i === 1 ? { ...r, t: '1999-01-01T00:00:00.000Z' } : r);

    // Still OK. A ledger offered as evidence of WHEN something was said does
    // not currently evidence when it was said.
    expect(verifyRecords(backdated).ok).toBe(true);
  });

  it('GAP: `layer` is outside the hash, so the ledger label can be rewritten', async () => {
    const c = await chainOf('one');
    const relabelled = c.records().map((r) => ({ ...r, layer: 'CRISIS_LOCK' as const }));

    // The parent dashboard renders `layer`. This says a turn was handled by a
    // layer that never touched it, and verification still reports OK.
    expect(verifyRecords(relabelled).ok).toBe(true);
  });

  it('GAP: the stored `prev` is ignored — it is decoration, not the link', async () => {
    const c = await chainOf('one', 'two');
    const relinked = c.records().map((r, i) =>
      i === 1 ? { ...r, prev: 'deadbeefdeadbeef' } : r);

    // The LINK is genuinely checked, via the running hash. The stored field is
    // not, so it can disagree with reality while verification says OK. That is
    // a forensics problem — someone reading the export sees a chain that does
    // not join up and a verifier that says it does.
    expect(verifyRecords(relinked).ok).toBe(true);
  });

  it('GAP: 64-bit truncation puts a second preimage at ~2^32 work', () => {
    // Not searched for here — 4 billion hashes is not a unit test. What IS
    // asserted is the property that makes it feasible, so the number in
    // PORT-REVIEW §4 is checked rather than remembered.
    expect(HASH_HEX_LENGTH).toBe(16);
    expect(sha('anything')).toHaveLength(16);
    // Birthday bound: 2^(64/2) = 2^32 ≈ 4.3e9 operations for a collision.
    expect(2 ** (HASH_HEX_LENGTH * 4 / 2)).toBe(4294967296);
  });
});

describe('what the chain claims about itself', () => {
  it('an untouched chain verifies, and reports its own length', async () => {
    const c = await chainOf('one', 'two', 'three');
    expect(verifyRecords(c.records())).toEqual(
      { ok: true, records: 3, brokenAt: null });
  });

  it('an empty chain verifies and heads at GENESIS', () => {
    const c = createChain();
    expect(c.head()).toBe(GENESIS);
    expect(verifyRecords(c.records())).toEqual(
      { ok: true, records: 0, brokenAt: null });
  });
});
