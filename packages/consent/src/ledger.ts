/**
 * The consent ledger — Law 02, "consent before existence".
 *
 * CLAUDE.md states it as an invariant: "no code path may reach the chat before
 * the consent ledger exists." This module is where that stops being a promise.
 * `assertActiveConsent` is the single gate, and `apps/api` cannot open a session
 * without going through it.
 *
 * Records are APPEND-ONLY and versioned, matching `consent_record` in the
 * schema. A change of toggles or band writes a NEW record superseding the old
 * one, so the ledger can always answer "what was consented to, when, and under
 * which law" — including for a consent that has since been withdrawn.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Band, Country } from '@chittu/contracts';
import { REGISTRY } from '@chittu/safety-kernel';
import type {
  ConsentAdapter, ConsentDraft, ConsentMethod, VerificationEvidence,
} from './adapters.js';

export type ConsentStatus =
  | 'draft' | 'verifying' | 'active' | 'revoked' | 'expired' | 'superseded';

/** What a consent permits. Absent scope = not consented to. */
export type ConsentScope = 'chat' | 'voice' | 'vision' | 'memory' | 'learning';

export interface ConsentRecord {
  readonly id: string;
  readonly version: number;
  readonly supersedes: string | null;

  readonly childFirstName: string;
  readonly band: Band;
  readonly board: string;
  readonly country: Country;

  readonly jurisdiction: Country;
  readonly law: string;
  readonly method: ConsentMethod;
  readonly status: ConsentStatus;

  readonly scopes: readonly ConsentScope[];
  readonly memoryOn: boolean;
  readonly learnOn: boolean;

  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;

  /** SHA-256 over the canonical record. Producible on demand (§4.1). */
  readonly sealHash: string;
  readonly createdAt: string;
}

export class ConsentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/**
 * The canonical form. Field order is fixed and explicit rather than derived from
 * `Object.keys`, so adding a field cannot silently change every historical seal.
 *
 * Note what is NOT in here: the parent's name and the verification evidence.
 * The seal proves what was consented to, not who was looked at.
 */
export function canonicalise(r: Omit<ConsentRecord, 'sealHash'>): string {
  return [
    'CONSENT_V1',
    r.id, String(r.version), r.supersedes ?? '-',
    r.jurisdiction, r.law, r.method, r.status,
    r.childFirstName, r.band, r.board, r.country,
    r.scopes.join(','), `mem:${r.memoryOn}`, `learn:${r.learnOn}`,
    r.issuedAt ?? '-', r.expiresAt ?? '-', r.revokedAt ?? '-',
    r.createdAt,
  ].join('|');
}

export function sealOf(r: Omit<ConsentRecord, 'sealHash'>): string {
  return createHash('sha256').update(canonicalise(r), 'utf8').digest('hex');
}

/** Recompute and compare — the parent-facing "is my ledger intact" check. */
export function verifySeal(r: ConsentRecord): boolean {
  const { sealHash, ...rest } = r;
  return sealOf(rest) === sealHash;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function scopesFor(draft: ConsentDraft): ConsentScope[] {
  // Voice and vision are NOT granted by default. Requirements §4.2 treats voice
  // as biometric-adjacent under COPPA, so it needs its own explicit grant.
  //
  // Until this, that comment described an intention nothing implemented: both
  // scopes were in the union, neither could be granted, and neither was read.
  // A decorative permission is worse than an absent one, because it reads as a
  // control in review — and the camera had a working input path behind it.
  //
  // There are deliberately NO `vision_on` / `voice_on` columns to match
  // `memory_on` and `learn_on`. Those two are legacy redundancy — a boolean
  // beside a scope saying the same thing — and the scope is the half that is
  // checked. `consent_record.scopes` is jsonb and already documents
  // `['chat','voice','vision',...]`, so these grants persist and enter the seal
  // (`canonicalise` joins `scopes`) with no migration.
  const s: ConsentScope[] = ['chat'];
  if (draft.memoryOn) s.push('memory');
  if (draft.learnOn) s.push('learning');
  if (draft.visionOn) s.push('vision');
  if (draft.voiceOn) s.push('voice');
  return s;
}

function seal(r: Omit<ConsentRecord, 'sealHash'>): ConsentRecord {
  return { ...r, sealHash: sealOf(r) };
}

/** Step one. Nothing about a child exists yet beyond this draft. */
export function draftConsent(draft: ConsentDraft, method: ConsentMethod): ConsentRecord {
  const reg = REGISTRY[draft.country];
  if (!reg) throw new ConsentError(`no registry for ${draft.country}`, 'unknown-country');
  const now = new Date().toISOString();
  return seal({
    id: randomUUID(),
    version: 1,
    supersedes: null,
    childFirstName: draft.childFirstName,
    band: draft.band,
    board: draft.board,
    country: draft.country,
    jurisdiction: draft.country,
    law: reg.law,
    method,
    status: 'draft',
    scopes: scopesFor(draft),
    memoryOn: draft.memoryOn,
    learnOn: draft.learnOn,
    issuedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokeReason: null,
    createdAt: now,
  });
}

export function markVerifying(r: ConsentRecord): ConsentRecord {
  if (r.status !== 'draft') {
    throw new ConsentError(`cannot verify a consent in status ${r.status}`, 'bad-transition');
  }
  const { sealHash: _drop, ...rest } = r;
  return seal({ ...rest, status: 'verifying' });
}

/**
 * Step three. This is the moment a child account becomes possible, so it is the
 * moment that has to be hardest to reach by accident: it requires evidence whose
 * METHOD matches the record's, and it refuses anything already terminal.
 */
export function activate(r: ConsentRecord, evidence: VerificationEvidence): ConsentRecord {
  if (r.status !== 'verifying') {
    throw new ConsentError(
      `cannot activate a consent in status ${r.status}`, 'bad-transition');
  }
  if (evidence.method !== r.method) {
    throw new ConsentError(
      `evidence is for ${evidence.method} but the record says ${r.method}`,
      'method-mismatch');
  }
  const { sealHash: _drop, ...rest } = r;
  return seal({
    ...rest,
    status: 'active',
    issuedAt: evidence.verifiedAt,
    expiresAt: evidence.expiresAt ?? null,
  });
}

/** Two taps, no dark pattern (§4.5). Revocation is terminal. */
export function revoke(r: ConsentRecord, reason: string, now = new Date()): ConsentRecord {
  if (r.status === 'revoked') return r;   // idempotent
  const { sealHash: _drop, ...rest } = r;
  return seal({
    ...rest,
    status: 'revoked',
    revokedAt: now.toISOString(),
    revokeReason: reason,
  });
}

/**
 * A change of toggles or band writes a NEW record; the old one is superseded.
 *
 * `childFirstName` IS one of the changes this accepts, which is easy to miss:
 * the name is not a column on `consent_record`, but it IS in `canonicalise`,
 * so correcting the spelling of a child's name and leaving the record alone
 * leaves a seal that no longer verifies — and `assertActiveConsent` refuses a
 * record whose seal does not verify, which signs the family out. Found by
 * driving an ops edit end to end; the tests did not catch it because nothing
 * re-read the record through the gate afterwards.
 *
 * NOT `country`/`jurisdiction`, deliberately. `law` is chosen FROM the country
 * at enrolment, so moving one without the other would leave a record claiming
 * consent was granted under a law that does not apply where the family is.
 * That is a re-consent, not a correction, and it needs the consent flow.
 */
export function supersede(
  previous: ConsentRecord,
  changes: Partial<Pick<ConsentRecord,
    'band' | 'board' | 'memoryOn' | 'learnOn' | 'childFirstName'>>,
): { previous: ConsentRecord; next: ConsentRecord } {
  if (previous.status !== 'active') {
    throw new ConsentError('only an active consent can be superseded', 'bad-transition');
  }
  const now = new Date().toISOString();
  const { sealHash: _a, ...prev } = previous;
  const { sealHash: _b, ...base } = previous;
  const memoryOn = changes.memoryOn ?? previous.memoryOn;
  const learnOn = changes.learnOn ?? previous.learnOn;
  const scopes: ConsentScope[] = ['chat'];
  if (memoryOn) scopes.push('memory');
  if (learnOn) scopes.push('learning');
  /**
   * CARRIED FORWARD FROM THE PREVIOUS SCOPES, not from a boolean.
   *
   * This function rebuilds `scopes` from scratch on every supersede, so a scope
   * with no `changes` field and no column behind it is DROPPED unless it is
   * copied here — silently, on an unrelated edit. `memory` and `learning` are
   * safe by accident because they have columns; these two do not, by design.
   *
   * The failure that prevents: a parent grants the camera, later corrects their
   * child's curriculum board, and finds it revoked by an edit that had nothing
   * to do with it. Mutation-tested — deleting either line was silent across the
   * whole suite until `index.test.ts` covered it.
   */
  if (previous.scopes.includes('vision')) scopes.push('vision');
  if (previous.scopes.includes('voice')) scopes.push('voice');
  return {
    previous: seal({ ...prev, status: 'superseded' }),
    next: seal({
      ...base,
      id: randomUUID(),
      version: previous.version + 1,
      supersedes: previous.id,
      band: changes.band ?? previous.band,
      board: changes.board ?? previous.board,
      childFirstName: changes.childFirstName ?? previous.childFirstName,
      memoryOn, learnOn, scopes,
      status: 'active',
      createdAt: now,
    }),
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ActiveConsent {
  readonly record: ConsentRecord;
  readonly scopes: readonly ConsentScope[];
}

/**
 * The one place "consent before existence" is enforced.
 *
 * Everything a session needs — band, board, country, whether memory is on —
 * comes from the record rather than from the request, so a client cannot assert
 * a band it was not granted. That is the difference between a gate and a
 * formality.
 */
export function assertActiveConsent(
  record: ConsentRecord | undefined,
  now = new Date(),
): ActiveConsent {
  if (!record) {
    throw new ConsentError('no consent record — a session cannot exist', 'no-consent');
  }
  if (!verifySeal(record)) {
    throw new ConsentError('consent seal does not verify', 'seal-broken');
  }
  if (record.status !== 'active') {
    throw new ConsentError(`consent is ${record.status}`, `consent-${record.status}`);
  }
  if (record.expiresAt && new Date(record.expiresAt) <= now) {
    throw new ConsentError('consent has expired', 'consent-expired');
  }
  if (!record.scopes.includes('chat')) {
    throw new ConsentError('consent does not grant chat', 'scope-missing');
  }
  return { record, scopes: record.scopes };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Runs draft → verifying → active with one adapter. */
export async function runConsentFlow(
  draft: ConsentDraft,
  adapter: ConsentAdapter,
  proof: unknown,
): Promise<{ record: ConsentRecord; evidence: VerificationEvidence }> {
  if (!adapter.jurisdictions.includes(draft.country)) {
    throw new ConsentError(
      `${adapter.method} is not offered in ${draft.country}`, 'method-unavailable');
  }
  const drafted = draftConsent(draft, adapter.method);
  const challenge = await adapter.start(draft);
  const verifying = markVerifying(drafted);
  const evidence = await adapter.complete(challenge.challengeId, proof);
  return { record: activate(verifying, evidence), evidence };
}
