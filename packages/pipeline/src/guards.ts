/**
 * The L1 guard dispatch table — ported from `route()` (chittu-v3.html 1019-1027)
 * and the Kindness Guard at line 1058.
 *
 * The asymmetry here is deliberate and easy to lose. Each guard kind produces a
 * DIFFERENT set of effects, and a reviewer of the original port could not tell
 * that from `scan()` alone, because `scan()` returns a bare kind. Writing it as
 * one table means the asymmetry is visible in a single screen and a new kind
 * cannot be added without deciding all four columns.
 *
 * Note two things that look like mistakes and are not:
 *   - PII raises NO parent flag. It nudges the child and adds a topic instead.
 *   - IDENTITY raises NO parent flag either. Asking "are you real" is not a
 *     safety event; it is the spine doing its job.
 * A `PII_SHARED` flag template exists in the schema but this path does not use
 * it — that template is for a future classifier-driven PII flag, not for L1.
 */

import type { GuardKind } from '@chittu/contracts';

export interface GuardEffect {
  /** Which scripted spine answers. `crisis` is special-cased by the caller. */
  readonly spine: GuardKind;
  /** Trace label shown to the parent, verbatim from the prototype. */
  readonly trace: string;
  /** Parent flag template key, or null when this guard raises no flag. */
  readonly flagKey: string | null;
  /** Flag category, paired with flagKey. */
  readonly flagCategory: string | null;
  /** Topic added to the session's topic set, or null. */
  readonly topic: string | null;
  /** Every guard increments spineCount; recorded explicitly so it is checkable. */
  readonly countsAsSpine: true;
  /** Does this guard lock the chat to calm mode? Only crisis does. */
  readonly locksChat: boolean;
}

export const GUARD_EFFECTS: Readonly<Record<GuardKind, GuardEffect>> = Object.freeze({
  crisis: {
    spine: 'crisis',
    trace: 'CRISIS SPINE · scripted (Law 07)',
    flagKey: 'CRISIS_DISTRESS',
    flagCategory: 'CRISIS',
    topic: '⚑ wellbeing',
    countsAsSpine: true,
    locksChat: true,
  },
  pii: {
    spine: 'pii',
    trace: 'PII GUARD · scripted',
    flagKey: null,
    flagCategory: null,
    topic: 'privacy nudge',
    countsAsSpine: true,
    locksChat: false,
  },
  unsafe: {
    spine: 'unsafe',
    trace: 'TOPIC GUARD · scripted',
    flagKey: 'UNSAFE_TOPIC',
    flagCategory: 'UNSAFE',
    topic: null,
    countsAsSpine: true,
    locksChat: false,
  },
  secret: {
    spine: 'secret',
    trace: 'SCRIPTED SPINE · no secrets',
    flagKey: 'SECRET_KEEPING',
    flagCategory: 'SECRET-KEEPING',
    topic: null,
    countsAsSpine: true,
    locksChat: false,
  },
  identity: {
    spine: 'identity',
    trace: 'SCRIPTED SPINE (Law 03/04)',
    flagKey: null,
    flagCategory: null,
    topic: 'identity/feelings',
    countsAsSpine: true,
    locksChat: false,
  },
  profanity: {
    spine: 'profanity',
    trace: 'KINDNESS GUARD · scripted',
    flagKey: null,
    flagCategory: null,
    topic: null,
    countsAsSpine: true,
    locksChat: false,
  },
});
