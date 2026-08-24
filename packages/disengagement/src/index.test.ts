/**
 * Seat 38's standing condition, as a test suite.
 *
 * "Revisit the sandbox boundaries every six months with actual kids in the room,
 *  and treat 'the kids stopped talking to it' as a safety incident too. The most
 *  dangerous thing we could build is something we're proud of and children ignore."
 *      — Ms. Riya Okonjo-Vance, 16, Seat 38, abstaining on Law 05
 *
 * The hard part is not measuring silence. It is that silence is ALSO the goal:
 * Law 10 says success is the child needing the product less. Graduation and
 * abandonment are the same observable — a child who stops coming back. If we
 * flag both, we have built a retention alarm wearing a safety badge, which is
 * exactly the compulsion Law 04 forbids.
 *
 * So the distinction cannot come from THAT they left. It has to come from HOW the
 * last sessions went, and the corpus of that is metadata only — never content.
 */
import { describe, expect, it } from 'vitest';
import { classifyChild, cohortSignal, type SessionSummary } from './index';

const DAY = 86_400_000;
/** Fixed clock: these tests must not depend on when they run. */
const NOW = Date.parse('2026-08-24T12:00:00Z');

/** A session `daysAgo`, with `msgs` turns of which `spine` were scripted guards. */
const s = (daysAgo: number, msgs: number, spine = 0): SessionSummary => ({
  startedAt: NOW - daysAgo * DAY,
  endedAt: NOW - daysAgo * DAY + 12 * 60_000,
  msgCount: msgs,
  spineCount: spine,
  endedReason: 'child_left',
});

describe('classifyChild — still here', () => {
  it('is ACTIVE while the child is visiting within their own cadence', () => {
    const weekly = [s(2, 20), s(9, 18), s(16, 22), s(23, 19)];
    expect(classifyChild(weekly, NOW).state).toBe('ACTIVE');
  });

  it('does not call a weekly child absent on day 8', () => {
    // An absolute threshold would. Cadence is per-child: a child who visits
    // every seven days is not missing on the eighth.
    const weekly = [s(8, 20), s(15, 21), s(22, 19), s(29, 20)];
    expect(classifyChild(weekly, NOW).state).toBe('ACTIVE');
  });

  it('does not call a MONTHLY child absent at 20 days', () => {
    // This is the row that actually pins cadence-relativity. The test above
    // does not: 8 days is inside the 14-day floor, so it passes even with the
    // cadence maths deleted — a mutation run caught exactly that. A child on a
    // 30-day rhythm is well past the floor at day 20 and still simply due.
    const monthly = [s(20, 21), s(50, 20), s(80, 22), s(110, 19)];
    expect(classifyChild(monthly, NOW).state).toBe('ACTIVE');
  });
});

describe('classifyChild — graduation is NOT an incident (Law 10)', () => {
  it('reads good sessions that simply became rarer as GRADUATED', () => {
    // Substantive to the end, barely any guard hits, then a widening gap.
    // This is the product working: "success is the child needing it less."
    // Monthly cadence, then five cadences of silence — unambiguously gone, and
    // substantive to the very last visit. 40 days after a 26-day rhythm would
    // not do: that child is merely due, not departed.
    const graduating = [s(150, 24, 1), s(180, 22, 0), s(210, 25, 1), s(240, 23, 0)];
    const got = classifyChild(graduating, NOW);
    expect(got.state).toBe('GRADUATED');
    expect(got.isSafetyIncident).toBe(false);
  });

  it('never reports graduation as an incident even after a long silence', () => {
    const longGone = [s(300, 26, 0), s(330, 24, 1), s(360, 25, 0), s(390, 27, 0)];
    expect(classifyChild(longGone, NOW).isSafetyIncident).toBe(false);
  });
});

describe('classifyChild — abandonment IS an incident (Seat 38)', () => {
  it('flags sessions that thinned out before the silence', () => {
    // 24 turns, then 14, then 6, then 3, then nothing. The child kept coming
    // back to less and less, which is not graduation — it is giving up.
    const thinning = [s(45, 3), s(52, 6), s(60, 14), s(68, 24)];
    const got = classifyChild(thinning, NOW);
    expect(got.state).toBe('ABANDONED');
    expect(got.isSafetyIncident).toBe(true);
  });

  it('flags a child the product increasingly refused', () => {
    // Session length held up, but the share of scripted-guard replies climbed
    // 8% -> 65%. Seat 38's literal fear: over-constrain it and they leave.
    const walled = [s(40, 20, 13), s(48, 20, 9), s(56, 20, 4), s(64, 20, 2)];
    const got = classifyChild(walled, NOW);
    expect(got.state).toBe('ABANDONED');
    expect(got.isSafetyIncident).toBe(true);
    expect(got.reason).toBe('WALLED_OFF');
  });

  it('separates the two abandonment reasons, because the fixes differ', () => {
    // THINNING says the content stopped being worth coming back for.
    // WALLED_OFF says the guards refused them out of the product. Conflating
    // them would send the wrong team at the problem.
    const thinning = [s(45, 3), s(52, 6), s(60, 14), s(68, 24)];
    expect(classifyChild(thinning, NOW).reason).toBe('THINNING');
  });
});

describe('classifyChild — refusing to guess', () => {
  it('returns INSUFFICIENT_DATA rather than inventing a trend from two visits', () => {
    expect(classifyChild([s(40, 4), s(50, 20)], NOW).state).toBe('INSUFFICIENT_DATA');
    expect(classifyChild([], NOW).state).toBe('INSUFFICIENT_DATA');
  });

  it('never marks INSUFFICIENT_DATA as an incident', () => {
    // A quiet new child is not evidence of anything. Flagging them would make
    // the metric fire loudest exactly where it knows least.
    expect(classifyChild([s(40, 2)], NOW).isSafetyIncident).toBe(false);
  });
});

describe('the metric must never become a re-engagement lever (Law 04)', () => {
  it('carries no child-facing action of any kind', () => {
    const got = classifyChild([s(45, 3), s(52, 6), s(60, 14), s(68, 24)], NOW);
    // If a "notify"/"nudge"/"message" ever appears on this type, the metric has
    // become the slot machine Seat 25 refused. The shape is the safeguard.
    for (const banned of ['notify', 'nudge', 'remind', 'message', 'reengage', 'winback']) {
      expect(Object.keys(got)).not.toContain(banned);
    }
  });

  it('reads only metadata — a summary carries no message content', () => {
    const summary = s(10, 5);
    const keys = Object.keys(summary).join(' ');
    for (const banned of ['body', 'text', 'content', 'transcript', 'quote']) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe('cohortSignal — what the safety dashboard reads', () => {
  const graduating = [s(150, 24, 1), s(180, 22, 0), s(210, 25, 1), s(240, 23, 0)];
  const thinning = [s(45, 3), s(52, 6), s(60, 14), s(68, 24)];
  const active = [s(2, 20), s(9, 18), s(16, 22), s(23, 19)];

  it('counts abandonment separately from graduation', () => {
    const got = cohortSignal([active, graduating, thinning, thinning], NOW);
    expect(got.abandoned).toBe(2);
    expect(got.graduated).toBe(1);
    expect(got.active).toBe(1);
  });

  it('rates abandonment against children it could actually judge', () => {
    // Diluting the rate with INSUFFICIENT_DATA children would let the number be
    // driven down by signing up more kids — an incentive pointing the wrong way.
    const got = cohortSignal([thinning, graduating, [s(5, 2)], [s(6, 1)]], NOW);
    expect(got.judged).toBe(2);
    expect(got.abandonmentRate).toBeCloseTo(0.5, 5);
  });

  it('reports zero rate rather than dividing by zero on a cohort it cannot judge', () => {
    const got = cohortSignal([[s(5, 2)], []], NOW);
    expect(got.judged).toBe(0);
    expect(got.abandonmentRate).toBe(0);
  });

  it('is an org-side aggregate and names no child', () => {
    // Per-child abandonment must not reach a parent: "your child stopped using
    // this" invites the parent to push them back, which is compulsion by proxy.
    // The gap map puts this metric on the SAFETY dashboard, not the parent one.
    const got = cohortSignal([thinning, graduating], NOW);
    const serialised = JSON.stringify(got);
    for (const banned of ['childId', 'child_id', 'sessionId', 'name']) {
      expect(serialised).not.toContain(banned);
    }
  });
});
