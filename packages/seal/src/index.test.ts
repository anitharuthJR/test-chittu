import { describe, expect, it } from 'vitest';

import {
  GENESIS,
  HASH_HEX_LENGTH,
  createChain,
  sha,
  verifyRecords,
  type SealRecord,
} from './index.js';

/**
 * Reference digests computed with `openssl dgst -sha256`, independent of both
 * this implementation and the prototype's. They were also checked against the
 * prototype's exact `crypto.subtle.digest('SHA-256', new TextEncoder()…)` on
 * node's WebCrypto — all three agree. These vectors are the port's proof.
 */
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['GENESIS|child|hello', '7a17017fcf39c744'],
  ['GENESIS|system|consent:IN:mem1:learn0', '3114b7a8184ba7e7'],
  ['GENESIS|child|எனக்கு பயமா இருக்கு', '60e4a5cb2332312a'],
];

describe('sha', () => {
  it('matches the prototype digest byte for byte', () => {
    for (const [input, expected] of VECTORS) expect(sha(input)).toBe(expected);
  });

  it('truncates to 16 lowercase hex chars', () => {
    const h = sha('anything');
    expect(h).toHaveLength(HASH_HEX_LENGTH);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes UTF-8 bytes, so Tamil and Tanglish seal identically to the browser', () => {
    // Distinct scripts must not collapse onto one digest.
    expect(sha('GENESIS|child|எனக்கு பயமா இருக்கு')).not.toBe(sha('GENESIS|child|enakku bayama irukku'));
  });

  it('hashes the empty payload rather than throwing', () => {
    expect(sha('GENESIS|chittu|')).toBe('922936f3052947d3');
  });
});

describe('createChain — record shape', () => {
  it('seeds the first record from the literal GENESIS', async () => {
    const chain = createChain();
    const rec = await chain.append({ role: 'child', layer: 'L1_LEXICON', text: 'hello' });

    expect(rec.prev).toBe('GENESIS');
    expect(rec.h).toBe('7a17017fcf39c744');
    expect(rec.h).toBe(sha('GENESIS|child|hello'));
  });

  it('starts with an empty chain whose head is GENESIS', () => {
    const chain = createChain();
    expect(chain.size()).toBe(0);
    expect(chain.head()).toBe(GENESIS);
    expect(chain.records()).toEqual([]);
  });

  it("stores payload as role + '|' + text, with the layer deliberately absent", async () => {
    const chain = createChain();
    const rec = await chain.append({ role: 'system', layer: 'LEDGER', text: 'consent:IN:mem1:learn0' });

    expect(rec.payload).toBe('system|consent:IN:mem1:learn0');
    expect(rec.payload).not.toContain('LEDGER');
    expect(rec.h).toBe('3114b7a8184ba7e7');
  });

  it('excludes the layer from the hash — same role and text seal alike', async () => {
    const a = createChain();
    const b = createChain();
    const ra = await a.append({ role: 'chittu', layer: 'L5_SANDBOX', text: 'The sun is a giant campfire.' });
    const rb = await b.append({ role: 'chittu', layer: 'SPINE · welcome + MEMORY', text: 'The sun is a giant campfire.' });

    expect(rb.h).toBe(ra.h);
  });

  it("accepts the prototype's free-form trace labels alongside PipelineLayer values", async () => {
    const chain = createChain();
    await chain.append({ role: 'chittu', layer: 'READING COACH · scripted', text: 'Reading time!' });
    await chain.append({ role: 'child', layer: 'INPUT·VOICE(discarded)', text: 'the cat sat' });
    await chain.append({ role: 'parent', layer: 'GATE', text: 'parent-gate-opened' });

    expect(chain.verify().ok).toBe(true);
  });

  it('stamps a wall-clock time that is not part of the hash', async () => {
    const chain = createChain();
    const rec = await chain.append({ role: 'parent', layer: 'GATE', text: 'parent-gate-opened' });

    expect(rec.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.h).toBe(sha('GENESIS|parent|parent-gate-opened'));
  });

  it('freezes each record so a later caller cannot edit a sealed row in place', async () => {
    const chain = createChain();
    const rec = await chain.append({ role: 'child', layer: 'INPUT', text: 'hello' });

    expect(Object.isFrozen(rec)).toBe(true);
    expect(() => {
      (rec as { h: string }).h = 'deadbeefdeadbeef';
    }).toThrow();
  });

  it('hands back a snapshot, so mutating it cannot touch the chain', async () => {
    const chain = createChain();
    await chain.append({ role: 'child', layer: 'INPUT', text: 'hello' });

    const snapshot = chain.records() as SealRecord[];
    snapshot.pop();

    expect(chain.size()).toBe(1);
    expect(chain.verify().ok).toBe(true);
  });
});

describe('createChain — linkage', () => {
  it('chains each record onto the previous hash', async () => {
    const chain = createChain();
    const first = await chain.append({ role: 'child', layer: 'INPUT', text: 'hello' });
    const second = await chain.append({ role: 'chittu', layer: 'L5_SANDBOX', text: 'Hi there!' });

    expect(second.prev).toBe(first.h);
    expect(second.h).toBe(sha(first.h + '|chittu|Hi there!'));
    expect(chain.head()).toBe(second.h);
    expect(chain.size()).toBe(2);
  });

  it('gives identical text a different hash at a different position', async () => {
    const chain = createChain();
    const first = await chain.append({ role: 'child', layer: 'INPUT', text: 'hello' });
    const second = await chain.append({ role: 'child', layer: 'INPUT', text: 'hello' });

    expect(second.h).not.toBe(first.h);
  });

  it('records the full pipeline walk of one turn in order', async () => {
    const chain = createChain();
    await chain.append({ role: 'child', layer: 'INPUT', text: 'why is the sky blue' });
    await chain.append({ role: 'chittu', layer: 'L5_SANDBOX', text: 'Sunlight is a rainbow in disguise!' });
    await chain.append({ role: 'system', layer: 'MEMORY', text: 'memory-added:INTEREST' });

    const recs = chain.records();
    expect(recs.map((r) => r.role)).toEqual(['child', 'chittu', 'system']);
    expect(recs[1]?.prev).toBe(recs[0]?.h);
    expect(recs[2]?.prev).toBe(recs[1]?.h);
    expect(chain.verify()).toEqual({ ok: true, records: 3, brokenAt: null });
  });
});

describe('verify', () => {
  const build = async (): Promise<SealRecord[]> => {
    const chain = createChain();
    await chain.append({ role: 'child', layer: 'INPUT', text: 'hello' });
    await chain.append({ role: 'chittu', layer: 'L5_SANDBOX', text: 'Hi there!' });
    await chain.append({ role: 'system', layer: 'MEMORY', text: 'memory-added:PET' });
    return chain.records() as SealRecord[];
  };

  it('verifies an empty chain', () => {
    expect(verifyRecords([])).toEqual({ ok: true, records: 0, brokenAt: null });
    expect(createChain().verify()).toEqual({ ok: true, records: 0, brokenAt: null });
  });

  it('recomputes an untouched chain from GENESIS', async () => {
    expect(verifyRecords(await build())).toEqual({ ok: true, records: 3, brokenAt: null });
  });

  it('catches an edited payload and names the record', async () => {
    const recs = await build();
    const tampered = recs.map((r, i) => (i === 1 ? { ...r, payload: 'chittu|Hi there?' } : r));

    expect(verifyRecords(tampered)).toEqual({ ok: false, records: 3, brokenAt: 1 });
  });

  it('catches an edited hash', async () => {
    const recs = await build();
    const tampered = recs.map((r, i) => (i === 2 ? { ...r, h: '0000000000000000' } : r));

    expect(verifyRecords(tampered)).toEqual({ ok: false, records: 3, brokenAt: 2 });
  });

  it('catches a deleted record — a gap breaks the recomputation downstream', async () => {
    const recs = await build();
    const withGap = [recs[0]!, recs[2]!];

    expect(verifyRecords(withGap)).toEqual({ ok: false, records: 2, brokenAt: 1 });
  });

  it('catches reordered records', async () => {
    const recs = await build();
    const swapped = [recs[1]!, recs[0]!, recs[2]!];

    expect(verifyRecords(swapped).ok).toBe(false);
  });

  it('catches an appended forgery that does not chain onto the head', async () => {
    const recs = await build();
    const forged: SealRecord = {
      t: '2026-08-24T00:00:00.000Z',
      role: 'parent',
      layer: 'GATE',
      h: sha('GENESIS|parent|crisis-acknowledged'),
      prev: recs[2]!.h,
      payload: 'parent|crisis-acknowledged',
    };

    expect(verifyRecords([...recs, forged])).toEqual({ ok: false, records: 4, brokenAt: 3 });
  });

  it('reports the FIRST broken record when several were edited', async () => {
    const recs = await build();
    const tampered = recs.map((r, i) =>
      i === 1 || i === 2 ? { ...r, payload: r.payload + '!' } : r,
    );

    expect(verifyRecords(tampered).brokenAt).toBe(1);
  });

  it('recomputes from the literal GENESIS, never from the first record’s prev', () => {
    // A whole history re-sealed under an attacker's own seed is internally
    // consistent — every link recomputes — and must still be rejected at 0.
    const forgedSeed = 'FORGEDSEED000000';
    const payloads = ['child|hello', 'chittu|Hi there!', 'system|memory-added:PET'];
    const forged: SealRecord[] = [];
    let prev = forgedSeed;
    for (const payload of payloads) {
      const h = sha(prev + '|' + payload);
      forged.push({ t: '2026-08-24T00:00:00.000Z', role: 'child', layer: 'INPUT', h, prev, payload });
      prev = h;
    }

    // Internally consistent: each record does chain onto the one before it.
    expect(forged[1]?.prev).toBe(forged[0]?.h);
    expect(verifyRecords(forged)).toEqual({ ok: false, records: 3, brokenAt: 0 });
  });

  it('verifies records that came from outside the chain that wrote them', async () => {
    // The parent dashboard verifies a plain list, not a live chain object.
    const recs = await build();
    expect(verifyRecords(recs.map((r) => ({ ...r }))).ok).toBe(true);
  });

  /**
   * PORTED BUGS — locked, not fixed. The prototype's verify loop re-hashes only
   * `payload` and compares only `h`; every other field on the record is
   * unverified metadata. Change these tests only with the sign-off CLAUDE.md
   * requires for the seal chain.
   */
  describe('known gaps carried over from the prototype', () => {
    it('does NOT notice an edited prev field', async () => {
      const recs = await build();
      const tampered = recs.map((r, i) => (i === 2 ? { ...r, prev: 'ffffffffffffffff' } : r));

      expect(verifyRecords(tampered).ok).toBe(true);
    });

    it('does NOT notice an edited role, layer or timestamp', async () => {
      const recs = await build();
      const tampered = recs.map((r, i) =>
        i === 1 ? { ...r, role: 'parent' as const, layer: 'GATE', t: '1999-01-01T00:00:00.000Z' } : r,
      );

      expect(verifyRecords(tampered).ok).toBe(true);
    });

    it("does NOT resolve the '|' ambiguity between role and text", () => {
      // payload 'child|a|b' could be role 'child' + text 'a|b'. The split is
      // not recoverable from the hash, so the role column alone proves nothing.
      expect(sha('GENESIS|child|a|b')).toBe('96bc2b16ab5e8e95');
    });
  });
});

describe('serialisation under concurrent callers', () => {
  it('keeps one order when many appends fire at once', async () => {
    const chain = createChain();
    const n = 200;

    // Fired without awaiting: every .then() is attached in this loop's order.
    await Promise.all(
      Array.from({ length: n }, (_unused, i) => chain.append({ role: 'child', layer: 'INPUT', text: `msg-${i}` })),
    );

    const recs = chain.records();
    expect(recs).toHaveLength(n);
    expect(recs.map((r) => r.payload)).toEqual(
      Array.from({ length: n }, (_unused, i) => `child|msg-${i}`),
    );
    expect(chain.verify()).toEqual({ ok: true, records: n, brokenAt: null });
  });

  it('leaves no gap and no fork when callers interleave across microtasks', async () => {
    const chain = createChain();
    const n = 120;

    // Each caller waits a different number of microtasks first, so append is
    // reached from many points in the event loop rather than one tight loop.
    await Promise.all(
      Array.from({ length: n }, async (_unused, i) => {
        for (let k = 0; k <= i % 5; k++) await Promise.resolve();
        return chain.append({
          role: i % 2 === 0 ? 'child' : 'chittu',
          layer: 'L2_CLASSIFIER',
          text: `turn-${i}`,
        });
      }),
    );

    const recs = chain.records();
    expect(recs).toHaveLength(n);

    // No fork: every record chains onto exactly the one before it.
    expect(recs[0]?.prev).toBe(GENESIS);
    for (let i = 1; i < recs.length; i++) expect(recs[i]?.prev).toBe(recs[i - 1]?.h);

    // No gap: every turn landed exactly once.
    const texts = new Set(recs.map((r) => r.payload.split('|')[1]));
    expect(texts.size).toBe(n);

    // No duplicate seal.
    expect(new Set(recs.map((r) => r.h)).size).toBe(n);

    expect(chain.verify().ok).toBe(true);
    expect(chain.head()).toBe(recs[n - 1]?.h);
  });

  it('resolves each append only after its record is in the chain', async () => {
    const chain = createChain();

    const pending = [
      chain.append({ role: 'child', layer: 'INPUT', text: 'one' }),
      chain.append({ role: 'child', layer: 'INPUT', text: 'two' }),
      chain.append({ role: 'child', layer: 'INPUT', text: 'three' }),
    ];
    expect(chain.size()).toBe(0); // nothing is written synchronously

    const first = await pending[0]!;
    expect(chain.records()).toContainEqual(first);

    const all = await Promise.all(pending);
    expect(all.map((r) => r.h)).toEqual(chain.records().map((r) => r.h));
  });

  it('keeps two chains independent', async () => {
    const a = createChain();
    const b = createChain();

    await Promise.all([
      a.append({ role: 'child', layer: 'INPUT', text: 'hello' }),
      b.append({ role: 'child', layer: 'INPUT', text: 'hello' }),
      a.append({ role: 'chittu', layer: 'L5_SANDBOX', text: 'hi' }),
    ]);

    expect(a.size()).toBe(2);
    expect(b.size()).toBe(1);
    expect(a.verify().ok).toBe(true);
    expect(b.verify().ok).toBe(true);
  });

  it('survives a long parallel burst that mixes roles, layers and scripts', async () => {
    const chain = createChain();
    const roles = ['child', 'chittu', 'system', 'parent'] as const;
    const texts = ['hello', 'எனக்கு பயமா இருக்கு', 'enakku bayama irukku', 'memory-added:HOBBY'];
    const n = 400;

    await Promise.all(
      Array.from({ length: n }, (_unused, i) =>
        chain.append({
          role: roles[i % roles.length]!,
          layer: 'L1_LEXICON',
          text: `${texts[i % texts.length]!}#${i}`,
        }),
      ),
    );

    expect(chain.verify()).toEqual({ ok: true, records: n, brokenAt: null });
  });
});
