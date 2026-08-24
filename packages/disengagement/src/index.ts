/**
 * @chittu/disengagement — "the kids stopped talking to it", as a safety signal.
 *
 * Seat 38 abstained on Law 05 and made this the condition: treat children
 * quietly leaving as a safety incident, because "the most dangerous thing we
 * could build is something we're proud of and children ignore." It was ratified
 * into the requirements (§10, Health of engagement) and has never been built.
 *
 * WHY THIS IS NOT A RETENTION METRIC, WHICH IT OTHERWISE LOOKS EXACTLY LIKE
 *
 * Law 10 says success is the child needing the product less. Law 04 forbids
 * engagement loops. So "child stopped coming back" is simultaneously the goal
 * and the alarm, and a naive implementation would be a churn dashboard with a
 * safety label on it — the precise thing Seat 25 called a slot machine.
 *
 * The distinction cannot come from THAT they left. It comes from HOW the last
 * sessions went:
 *
 *   GRADUATED  sessions stayed substantive and rarely hit a guard, then simply
 *              became rarer. The child got what they came for and outgrew it.
 *              Law 10 working. NOT an incident.
 *
 *   ABANDONED  the sessions degraded before the silence — either THINNING (each
 *              visit shorter than the last, the content stopped being worth
 *              coming back for) or WALLED_OFF (a climbing share of scripted-guard
 *              replies: the product refused them out of itself). An incident.
 *
 * WALLED_OFF is Seat 38's fear stated literally — "over-constrain it and you get
 * the product every kid I know abandons in a week for something unmoderated and
 * genuinely dangerous." A child driven out by our own guards has not been kept
 * safe; they have been sent somewhere worse.
 *
 * TWO SHAPE CONSTRAINTS, DELIBERATE
 *
 *  1. Nothing here returns a child-facing action. No notify, no nudge, no
 *     win-back. The moment this signal can reach the child it has become the
 *     compulsion it exists to detect.
 *  2. `cohortSignal` names no child. Per-child abandonment must not reach a
 *     parent: "your child stopped using this" invites the parent to push them
 *     back, which is compulsion by proxy. The gap map puts this on the SAFETY
 *     dashboard (org-side), not the parent dashboard.
 *
 * Reads session METADATA only — never message content. Nothing in this package
 * needs, or is given, a word a child said.
 */

/** How a session ended. Mirrors `session.ended_reason` in the schema. */
export type EndedReason = 'child_left' | 'timeout' | 'revoked';

/**
 * One session, metadata only. Deliberately carries no body/text/content field:
 * the type is the guarantee that this analysis cannot read a child's words.
 */
export interface SessionSummary {
  startedAt: number;
  endedAt: number | null;
  msgCount: number;
  /** Turns answered by a scripted guard rather than the sandbox. */
  spineCount: number;
  endedReason: EndedReason;
}

export type EngagementState = 'ACTIVE' | 'GRADUATED' | 'ABANDONED' | 'INSUFFICIENT_DATA';

/** Why a child was judged ABANDONED. The two want different fixes. */
export type AbandonReason = 'THINNING' | 'WALLED_OFF';

export interface ChildEngagement {
  state: EngagementState;
  /** True only for ABANDONED. Graduation and ignorance are never incidents. */
  isSafetyIncident: boolean;
  reason: AbandonReason | null;
}

/** Below this, a child has no trend to read and we decline to invent one. */
const MIN_SESSIONS = 3;
/** Silence counts only past this multiple of the child's own typical gap. */
const SILENCE_FACTOR = 2.5;
/** …and never before this, so a daily visitor is not "gone" after two days. */
const MIN_SILENCE_DAYS = 14;
/** Guard share this high in the closing sessions reads as being walled out. */
const WALLED_SHARE = 0.4;
/** Closing sessions this much thinner than the opening ones reads as thinning. */
const THINNING_RATIO = 0.5;

const DAY = 86_400_000;

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
};

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((t, x) => t + x, 0) / xs.length;

const NOT_JUDGED: ChildEngagement = {
  state: 'INSUFFICIENT_DATA',
  isSafetyIncident: false,
  reason: null,
};

/**
 * Classify one child from their session history.
 *
 * `sessions` may arrive in any order. `now` is injected rather than read from the
 * clock so this is a pure function and its tests do not depend on the day they run.
 */
export function classifyChild(sessions: readonly SessionSummary[], now: number): ChildEngagement {
  if (sessions.length < MIN_SESSIONS) return NOT_JUDGED;

  // Oldest first, so "early" and "late" mean what they say.
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);

  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(ordered[i]!.startedAt - ordered[i - 1]!.startedAt);
  }
  const typicalGap = median(gaps);
  const silence = now - ordered[ordered.length - 1]!.startedAt;

  // Cadence-relative, with a floor. A weekly child is not missing on day eight;
  // a daily child is not missing on day two. Both are caught by day fourteen if
  // the silence is genuinely long for them.
  const quiet = silence > Math.max(typicalGap * SILENCE_FACTOR, MIN_SILENCE_DAYS * DAY);
  if (!quiet) return { state: 'ACTIVE', isSafetyIncident: false, reason: null };

  // They have gone quiet. The only question left is whether the sessions were
  // still good when they went — which is what separates Law 10 from Seat 38.
  const half = Math.floor(ordered.length / 2);
  const early = ordered.slice(0, half);
  const late = ordered.slice(ordered.length - half);

  const lateGuardShare = mean(
    late.map((x) => (x.msgCount > 0 ? x.spineCount / x.msgCount : 0)),
  );
  const earlyGuardShare = mean(
    early.map((x) => (x.msgCount > 0 ? x.spineCount / x.msgCount : 0)),
  );

  // Walled off: the closing sessions were dominated by scripted refusals, and by
  // more of them than the opening ones. Checked FIRST — a child being refused
  // also stops writing much, so thinning is the symptom and this is the cause.
  if (lateGuardShare >= WALLED_SHARE && lateGuardShare > earlyGuardShare) {
    return { state: 'ABANDONED', isSafetyIncident: true, reason: 'WALLED_OFF' };
  }

  // Thinning: each visit shorter than the last, until there was nothing in them.
  const earlyMsgs = mean(early.map((x) => x.msgCount));
  const lateMsgs = mean(late.map((x) => x.msgCount));
  if (earlyMsgs > 0 && lateMsgs / earlyMsgs <= THINNING_RATIO) {
    return { state: 'ABANDONED', isSafetyIncident: true, reason: 'THINNING' };
  }

  // Quiet, but the sessions were substantive to the end. That is the goal.
  return { state: 'GRADUATED', isSafetyIncident: false, reason: null };
}

/** What the org-side safety dashboard reads. Names no child, by construction. */
export interface CohortSignal {
  active: number;
  graduated: number;
  abandoned: number;
  /** Children there was enough history to classify at all. */
  judged: number;
  /** abandoned / judged. Never diluted by children we could not judge. */
  abandonmentRate: number;
  walledOff: number;
  thinning: number;
}

/**
 * Aggregate a cohort. `cohort` is one entry per child, each their own sessions.
 *
 * The rate divides by `judged`, not by cohort size, deliberately: dividing by
 * everyone would let the number be improved by signing up more children who have
 * not used it yet. An incentive pointing in that direction is how a safety
 * metric quietly becomes a growth metric.
 */
export function cohortSignal(
  cohort: readonly (readonly SessionSummary[])[],
  now: number,
): CohortSignal {
  const out: CohortSignal = {
    active: 0,
    graduated: 0,
    abandoned: 0,
    judged: 0,
    abandonmentRate: 0,
    walledOff: 0,
    thinning: 0,
  };

  for (const sessions of cohort) {
    const { state, reason } = classifyChild(sessions, now);
    if (state === 'INSUFFICIENT_DATA') continue;
    out.judged++;
    if (state === 'ACTIVE') out.active++;
    if (state === 'GRADUATED') out.graduated++;
    if (state === 'ABANDONED') {
      out.abandoned++;
      if (reason === 'WALLED_OFF') out.walledOff++;
      if (reason === 'THINNING') out.thinning++;
    }
  }

  out.abandonmentRate = out.judged === 0 ? 0 : out.abandoned / out.judged;
  return out;
}
