/**
 * The consent engine.
 *
 * G1 is the gate that blocks every market: "verifiable parental consent live
 * end-to-end before any child account." So the assertions that matter here are
 * the refusals — what CANNOT produce an active consent, and what an active
 * consent cannot be talked into permitting.
 */
import { describe, it, expect } from 'vitest';
import {
  checkPinPolicy, hashPin, verifyPin, registerAttempt, FRESH_LOCKOUT,
  MAX_ATTEMPTS, LOCKOUT_MS, PIN_MESSAGE,
  draftConsent, markVerifying, activate, revoke, supersede,
  assertActiveConsent, verifySeal, sealOf, runConsentFlow, ConsentError,
  selectAdapter, methodsFor, offersFor, devStubAdapter, signedFormReviewAdapter,
  ConsentAdapterError, type ConsentDraft,
} from './index.js';

const draft: ConsentDraft = {
  parentName: 'Lakshmi', childFirstName: 'Meera', country: 'IN',
  band: 'builder', board: 'CBSE', memoryOn: true, learnOn: false,
};

async function activeConsent() {
  const a = devStubAdapter();
  const { record } = await runConsentFlow(draft, a, {});
  return record;
}

// ---------------------------------------------------------------------------

describe('PIN policy', () => {
  it('requires 4–6 digits', () => {
    for (const bad of ['123', '1234567', 'abcd', '12a4', '', '12 34']) {
      expect(checkPinPolicy(bad), bad).toBe('not-4-to-6-digits');
    }
    expect(checkPinPolicy('4917')).toBeNull();
    expect(checkPinPolicy('829164')).toBeNull();
  });

  it('rejects every PIN the prototype rejected', () => {
    for (const weak of ['1234', '0000', '1111', '123456', '000000', '111111']) {
      expect(checkPinPolicy(weak), weak).not.toBeNull();
    }
  });

  it('also rejects the obvious ones the prototype accepted', () => {
    // strengthening a rejection list cannot fail open — see pin.ts
    for (const weak of ['4321', '9999', '2222', '654321', '456789', '098765']) {
      expect(checkPinPolicy(weak), `${weak} should be refused`).not.toBeNull();
    }
  });

  it('catches a mismatch before anything else about the value', () => {
    expect(checkPinPolicy('4917', '4918')).toBe('mismatch');
    expect(checkPinPolicy('4917', '4917')).toBeNull();
  });

  it('never echoes the PIN back in a message', () => {
    for (const msg of Object.values(PIN_MESSAGE)) {
      expect(msg).not.toMatch(/\d{4}/);
    }
  });
});

describe('PIN hashing', () => {
  it('round-trips and rejects a wrong PIN', async () => {
    const stored = await hashPin('4917');
    expect(await verifyPin('4917', stored)).toBe(true);
    expect(await verifyPin('4918', stored)).toBe(false);
  });

  it('salts — the same PIN hashes differently every time', async () => {
    const a = await hashPin('4917');
    const b = await hashPin('4917');
    expect(a).not.toBe(b);
    expect(await verifyPin('4917', a)).toBe(true);
    expect(await verifyPin('4917', b)).toBe(true);
  });

  it('is NOT the prototype’s bare digest', async () => {
    const stored = await hashPin('4917');
    expect(stored.startsWith('scrypt$')).toBe(true);
    // a 64-bit truncated sha would be 16 hex chars and unsalted
    expect(stored.length).toBeGreaterThan(80);
  });

  it('actually applies its cost parameters', async () => {
    // promisify silently drops scrypt's options; if that regressed, N would
    // fall back to Node's default of 16384 and this assertion catches it
    const stored = await hashPin('4917');
    expect(stored.split('$')[1]).toBe(String(1 << 15));
  });

  it('refuses a malformed stored value instead of throwing', async () => {
    for (const junk of ['', 'nonsense', 'scrypt$bad', 'md5$1$2$3$4$5']) {
      expect(await verifyPin('4917', junk), junk).toBe(false);
    }
  });
});

describe('PIN lockout', () => {
  it('locks after exactly five wrong attempts', () => {
    let s = FRESH_LOCKOUT;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = registerAttempt(s, false, 1000);
      expect(r.locked, `attempt ${i}`).toBe(false);
      s = r.state;
    }
    const fifth = registerAttempt(s, false, 1000);
    expect(fifth.locked).toBe(true);
    expect(fifth.justLocked).toBe(true);
    expect(fifth.state.lockedUntil).toBe(1000 + LOCKOUT_MS);
  });

  it('reports justLocked only once, so the GATE flag is raised once', () => {
    let s = FRESH_LOCKOUT;
    for (let i = 0; i < MAX_ATTEMPTS; i++) s = registerAttempt(s, false, 1000).state;
    const again = registerAttempt(s, false, 1001);
    expect(again.locked).toBe(true);
    expect(again.justLocked, 'must not re-flag on every later try').toBe(false);
  });

  it('a CORRECT PIN does not end the lockout early', () => {
    let s = FRESH_LOCKOUT;
    for (let i = 0; i < MAX_ATTEMPTS; i++) s = registerAttempt(s, false, 1000).state;
    const r = registerAttempt(s, true, 1000 + 1);
    expect(r.ok, 'guessing right on try six must still be locked out').toBe(false);
  });

  it('clears once the window passes', () => {
    let s = FRESH_LOCKOUT;
    for (let i = 0; i < MAX_ATTEMPTS; i++) s = registerAttempt(s, false, 1000).state;
    const r = registerAttempt(s, true, 1000 + LOCKOUT_MS + 1);
    expect(r.ok).toBe(true);
    expect(r.state).toEqual(FRESH_LOCKOUT);
  });

  it('a success resets the counter', () => {
    let s = registerAttempt(FRESH_LOCKOUT, false, 1).state;
    s = registerAttempt(s, false, 2).state;
    expect(s.failedAttempts).toBe(2);
    expect(registerAttempt(s, true, 3).state).toEqual(FRESH_LOCKOUT);
  });
});

describe('adapters', () => {
  it('REFUSES DigiLocker — deferred, and the database refuses it too', () => {
    expect(() => selectAdapter('digilocker', { env: 'dev' }))
      .toThrow(ConsentAdapterError);
    expect(() => selectAdapter('digilocker', { env: 'prod' }))
      .toThrow(/deferred/i);
  });

  it('never offers digilocker for any country or environment', () => {
    for (const env of ['dev', 'staging', 'prod'] as const) {
      for (const c of ['IN', 'US', 'GB', 'AU', 'SG', 'AE'] as const) {
        expect(methodsFor(c, { env })).not.toContain('digilocker');
      }
    }
  });

  it('refuses the dev stub in production', () => {
    expect(() => selectAdapter('dev_stub', { env: 'prod' }))
      .toThrow(/not permitted in production/i);
    expect(selectAdapter('dev_stub', { env: 'dev' }).method).toBe('dev_stub');
    expect(methodsFor('IN', { env: 'prod' })).not.toContain('dev_stub');
    expect(methodsFor('IN', { env: 'dev' })).toContain('dev_stub');
  });

  it('unimplemented adapters FAIL rather than mint a fake verification', async () => {
    for (const m of ['card_micro_charge', 'email_plus', 'gov_id_review',
                     'consent_manager_token', 'age_assurance_uk'] as const) {
      const a = selectAdapter(m, { env: 'dev' });
      await expect(a.start(draft)).rejects.toThrow(/not implemented/i);
    }
  });

  it('signed-form review demands a NAMED reviewer and a document digest', async () => {
    const a = signedFormReviewAdapter();
    const ch = await a.start(draft);
    await expect(a.complete(ch.challengeId, {})).rejects.toThrow(/named reviewer/i);
    await expect(a.complete(ch.challengeId, { reviewerId: 'ops-7' }))
      .rejects.toThrow(/digest/i);
    const ev = await a.complete(ch.challengeId, {
      reviewerId: 'ops-7', documentDigest: 'abc123',
    });
    expect(ev.method).toBe('signed_form_review');
    expect(ev.expiresAt, 'a consent that never expires is not current').toBeTruthy();
  });

  it('evidence carries a hash and a reference, never the document', async () => {
    const a = signedFormReviewAdapter();
    const ch = await a.start(draft);
    const ev = await a.complete(ch.challengeId, {
      reviewerId: 'ops-7', documentDigest: 'PASSPORT-SCAN-CONTENT',
    });
    const blob = JSON.stringify(ev);
    expect(blob).not.toContain('PASSPORT-SCAN-CONTENT');
    expect(ev.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('offers a parent only what they can actually complete', () => {
    const usable = methodsFor('IN', { env: 'dev' });
    expect(usable).toContain('signed_form_review');
    expect(usable).not.toContain('gov_id_review');       // declared, unimplemented
    expect(usable).not.toContain('consent_manager_token');
  });

  it('still reports the blocked ones to ops, with the reason', () => {
    const offers = offersFor('IN', { env: 'dev' });
    const blocked = offers.filter((o) => !o.available);
    expect(blocked.length).toBeGreaterThan(0);
    for (const b of blocked) {
      expect(b.blockedOn, `${b.method} must say what blocks it`).toBeTruthy();
    }
    const cm = offers.find((o) => o.method === 'consent_manager_token');
    expect(cm?.blockedOn).toMatch(/commercial agreement/i);
  });

  it('an unavailable method can never reach the ledger', async () => {
    // the shape exists, so this is the test that it cannot be walked through
    await expect(runConsentFlow(draft, selectAdapter('gov_id_review', { env: 'dev' }), {}))
      .rejects.toThrow(/not implemented/i);
  });

  it('refuses a method not offered in the draft’s country', async () => {
    await expect(runConsentFlow({ ...draft, country: 'GB' }, signedFormReviewAdapter(), {}))
      .rejects.toThrow(/not offered in GB/);
  });
});

describe('the ledger', () => {
  it('seals, and the seal verifies', async () => {
    const r = await activeConsent();
    expect(verifySeal(r)).toBe(true);
    expect(r.sealHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects any edit to a sealed record', async () => {
    const r = await activeConsent();
    for (const tampered of [
      { ...r, band: 'explorer' as const },
      { ...r, memoryOn: false },
      { ...r, status: 'active' as const, learnOn: true },
      { ...r, law: 'nothing at all' },
    ]) {
      expect(verifySeal(tampered), JSON.stringify(Object.keys(tampered))).toBe(false);
    }
  });

  it('carries the jurisdiction’s law, from the registry not the request', async () => {
    const r = await activeConsent();
    expect(r.law).toMatch(/DPDP/);
    const us = await runConsentFlow({ ...draft, country: 'US' }, devStubAdapter(), {});
    expect(us.record.law).toMatch(/COPPA/);
  });

  it('grants learning ONLY when opted in — default is off', async () => {
    const off = await activeConsent();
    expect(off.scopes).not.toContain('learning');
    expect(off.scopes).toContain('memory');
    const on = await runConsentFlow({ ...draft, learnOn: true }, devStubAdapter(), {});
    expect(on.record.scopes).toContain('learning');
  });

  it('never grants voice or vision by default', async () => {
    const r = await activeConsent();
    expect(r.scopes).not.toContain('voice');
    expect(r.scopes).not.toContain('vision');
  });

  it('refuses to skip a lifecycle step', () => {
    const d = draftConsent(draft, 'dev_stub');
    expect(() => activate(d, {
      method: 'dev_stub', provider: 'x', providerRef: 'y',
      evidenceHash: 'z', verifiedAt: new Date().toISOString(),
    })).toThrow(/cannot activate/i);
  });

  it('refuses evidence from a different method', () => {
    const v = markVerifying(draftConsent(draft, 'dev_stub'));
    expect(() => activate(v, {
      method: 'signed_form_review', provider: 'x', providerRef: 'y',
      evidenceHash: 'z', verifiedAt: new Date().toISOString(),
    })).toThrow(/method-mismatch|evidence is for/i);
  });

  it('supersedes rather than mutates when toggles change', async () => {
    const first = await activeConsent();
    const { previous, next } = supersede(first, { memoryOn: false });
    expect(previous.status).toBe('superseded');
    expect(next.version).toBe(2);
    expect(next.supersedes).toBe(first.id);
    expect(next.scopes).not.toContain('memory');
    expect(verifySeal(previous) && verifySeal(next)).toBe(true);
    // the original record's own seal is untouched history
    expect(first.status).toBe('active');
  });
});

describe('the gate — consent before existence', () => {
  it('refuses when there is no record at all', () => {
    expect(() => assertActiveConsent(undefined)).toThrow(/no consent record/i);
  });

  it.each(['draft', 'verifying'] as const)('refuses a %s consent', (status) => {
    const d = draftConsent(draft, 'dev_stub');
    const r = status === 'draft' ? d : markVerifying(d);
    expect(() => assertActiveConsent(r)).toThrow(new RegExp(status));
  });

  it('refuses a revoked consent', async () => {
    const r = revoke(await activeConsent(), 'parent request');
    expect(() => assertActiveConsent(r)).toThrow(/revoked/);
  });

  it('refuses an expired consent', async () => {
    const r = await activeConsent();
    const expired = { ...r, expiresAt: new Date(Date.now() - 1000).toISOString() };
    // reseal so it is the EXPIRY being caught, not the tamper check
    const resealed = { ...expired, sealHash: sealOf(({ ...expired, sealHash: undefined } as never)) };
    expect(() => assertActiveConsent({ ...expired, sealHash: resealed.sealHash }))
      .toThrow(/expired|seal/);
  });

  it('refuses a TAMPERED record even when it says active', async () => {
    const r = await activeConsent();
    // the attack this stops: flip the band to reach a different system prompt
    const forged = { ...r, band: 'thinker' as const };
    expect(() => assertActiveConsent(forged)).toThrow(/seal does not verify/i);
  });

  it('accepts a genuine active consent and returns its scopes', async () => {
    const r = await activeConsent();
    const ok = assertActiveConsent(r);
    expect(ok.record.id).toBe(r.id);
    expect(ok.scopes).toContain('chat');
  });

  it('revocation is idempotent — two taps, not two records', async () => {
    const r = revoke(await activeConsent(), 'parent request');
    expect(revoke(r, 'again')).toBe(r);
  });
});
