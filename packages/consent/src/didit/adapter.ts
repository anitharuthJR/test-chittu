/**
 * `automated_id_check` — the first consent rail that can verify a stranger.
 *
 * Three independent facts have to hold before this mints a consent:
 *
 *   1. Didit's status is exactly `Approved`;
 *   2. the document holder is 18 or over;
 *   3. the name the parent typed describes the person on the document.
 *
 * All three are checked here, against a verdict this process fetched from
 * Didit over its own connection. NOTHING in the decision comes from the
 * client. A browser returning from the hosted flow can say "I am done"; it
 * cannot say "I passed", and `proof` carries only the name to compare.
 *
 * What gets written when all three hold: the session id as `providerRef`, and a
 * hash over the session id, the status, the workflow and the two booleans. The
 * NAME IS NOT A HASH INPUT — a stored hash of a name is a guessing oracle
 * against a small, highly predictable space, which is the opposite of what
 * `hashEvidence` is for.
 */

import { randomUUID } from 'node:crypto';
import type { Country } from '@chittu/contracts';
import {
  ConsentAdapterError, hashEvidence,
  type ConsentAdapter, type ConsentDraft,
  type VerificationChallenge, type VerificationEvidence,
} from '../adapters.js';
import { createSession, fetchDecision, DiditTransportError, type DiditConfig } from './client.js';
import { matchesIdName } from './name-match.js';

/** Didit is global; these are the markets Chittu itself serves. */
const JURISDICTIONS: readonly Country[] = ['IN', 'US', 'GB', 'AU', 'SG', 'AE'];

/** How many times a parent may correct the name against one capture session. */
export const MAX_NAME_ATTEMPTS = 3;

export interface DiditAdapterOptions {
  readonly config: DiditConfig;
  readonly fetchImpl?: typeof fetch;
  /**
   * Attempts already spent against this consent. Read from `consent_record`
   * by the caller — a client-supplied count is not a bound.
   */
  readonly attemptsUsed?: number;
}

/** Proof the client sends to `finalize`. A name, and nothing that decides anything. */
export interface DiditProof {
  readonly fullName?: string;
}

const fail = (message: string, code: string, retryable: boolean): never => {
  throw new ConsentAdapterError(message, 'automated_id_check', { code, retryable });
};

export function diditAdapter(opts: DiditAdapterOptions): ConsentAdapter {
  const { config, fetchImpl } = opts;
  const attemptsUsed = opts.attemptsUsed ?? 0;

  return {
    method: 'automated_id_check',
    jurisdictions: JURISDICTIONS,
    available: true,

    async start(_draft: ConsentDraft): Promise<VerificationChallenge> {
      // The challenge id is a fresh random value and is the ONLY thing that
      // travels to Didit as `vendor_data`. The draft is not consulted: nothing
      // about this family needs to leave the building to open a session.
      const challengeId = randomUUID();
      let session;
      try {
        session = await createSession(config, challengeId, fetchImpl);
      } catch (e) {
        const t = e instanceof DiditTransportError;
        return fail(
          e instanceof Error ? e.message : 'could not start the ID check',
          'didit_unavailable',
          t ? (e as DiditTransportError).retryable : false,
        );
      }
      return {
        // The Didit session id IS the challenge id from here on: `finalize`
        // must ask Didit about the session the parent actually completed, and
        // carrying two ids would let those two drift apart.
        challengeId: session.sessionId,
        method: 'automated_id_check',
        instructions:
          'Check your photo ID on the next screen. You will need the ID itself and '
          + 'a moment somewhere well lit. We never see or store the document — our '
          + 'verification partner checks it and tells us only whether it passed.',
        redirectUrl: session.url,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      };
    },

    async complete(challengeId: string, proof: unknown): Promise<VerificationEvidence> {
      if (attemptsUsed >= MAX_NAME_ATTEMPTS) {
        return fail(
          'too many attempts to match the name on the ID', 'attempts_exhausted', false);
      }

      let outcome;
      try {
        outcome = await fetchDecision(config, challengeId, fetchImpl);
      } catch (e) {
        const t = e instanceof DiditTransportError;
        return fail(
          e instanceof Error ? e.message : 'could not read the ID check result',
          'didit_unavailable',
          t ? (e as DiditTransportError).retryable : false,
        );
      }

      switch (outcome.status) {
        case 'Approved':
          break;
        case 'In Review':
          return fail(
            'the ID check is still being reviewed — come back shortly',
            'pending_review', true);
        case 'Not Started': case 'In Progress': case 'Awaiting User': case 'Resubmitted':
          return fail('the ID check is not finished yet', 'pending_capture', true);
        case 'Declined':
          return fail('the ID check did not pass', 'declined', false);
        case 'Expired': case 'Kyc Expired': case 'Abandoned':
          return fail('the ID check expired before it was finished', 'expired', false);
      }

      // An approved check on a minor's document is not parental consent. This is
      // terminal: a second attempt cannot change how old the document holder is.
      if (!outcome.isAdult) {
        return fail(
          'the ID does not show an adult — a parent or guardian must give consent',
          'not_adult', false);
      }

      // No name on the decision at all is OUR misconfiguration, not the
      // parent's mistake: the workflow's returned-data list has been narrowed
      // past `full_name`. Distinguished from a mismatch so it does not burn an
      // attempt, and terminal because retyping cannot conjure a field the
      // vendor was told not to send.
      if (outcome.documentName.trim() === '') {
        return fail(
          'the ID check returned no name to compare — the verification workflow '
          + 'is misconfigured', 'no_name_returned', false);
      }

      const typed = (proof as DiditProof | undefined)?.fullName ?? '';
      const m = matchesIdName(typed, outcome.documentName);
      if (!m.matched) {
        const left = MAX_NAME_ATTEMPTS - attemptsUsed - 1;
        return fail(
          left > 0
            ? 'that name does not match the ID — type it exactly as printed'
            : 'that name does not match the ID',
          'name_mismatch', left > 0);
      }

      return {
        method: 'automated_id_check',
        provider: 'didit',
        providerRef: challengeId,
        evidenceHash: hashEvidence({
          session: challengeId,
          status: outcome.status,
          workflow: config.workflowId,
          adult: 'true',
          matched: 'true',
        }),
        verifiedAt: new Date().toISOString(),
        // Re-verify annually. A consent that never expires is not "current".
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString(),
      };
    },
  };
}
