/**
 * D5/HARNESS — "run 5 live checks vs truth", from a parent's dashboard.
 *
 * The prototype's version (`runMathHarness`, chittu-v3.html:677) asked the
 * MODEL for five sums and graded the replies. This one does not, and the
 * difference is the point rather than a shortcut: in the shipped product pure
 * arithmetic never reaches a vendor — `MATH_ENGINE` sits above `L2_CLASSIFIER`
 * in `PIPELINE_ORDER` and returns before either model port is constructed. A
 * harness that graded a model would be auditing a code path a child's sums do
 * not take, and would quietly make five vendor calls from a dashboard while
 * doing it. `certification.test.ts` counts them: the number must stay zero.
 *
 * So this runs `mathTurn` — the pipeline layer itself, at this child's band and
 * board — and grades it against answers a person wrote down.
 */

import { mathTurn, type MathContext } from '@chittu/maths-engine';

export interface HarnessProblem {
  /** Typed the way a child types it, so the PARSER is audited too, not just `calc`. */
  readonly ask: string;
  /** The sum as a parent should see it printed. */
  readonly shown: string;
  /** Hand-computed. Never derived from `calc` — see the note below. */
  readonly truth: number;
}

/**
 * Five problems, and five answers written out by a person.
 *
 * **The truth column must never be computed.** Deriving it from `calc()` would
 * grade the engine against itself and pass unconditionally — the exact defect
 * found three times in this repo already (the 169-probe lexicon sweep, the
 * guard grader, the `# !! INVALID` adapter scorecards). A test pins these five
 * literals for the same reason.
 *
 * The five are the prototype's, kept so the two dashboards audit the same sums:
 * one of each operation, plus a multiplication too large to draw as a picture.
 */
export const HARNESS_ITEMS: readonly HarnessProblem[] = Object.freeze([
  { ask: 'what is 7 x 8', shown: '7 × 8', truth: 56 },
  { ask: 'what is 48 / 6', shown: '48 ÷ 6', truth: 8 },
  { ask: 'what is 125 + 375', shown: '125 + 375', truth: 500 },
  { ask: 'what is 1000 - 247', shown: '1000 − 247', truth: 753 },
  { ask: 'what is 15 x 12', shown: '15 × 12', truth: 180 },
]);

export interface HarnessItem {
  readonly shown: string;
  readonly truth: number;
  /** What the engine answered, or null when it did not recognise the sum. */
  readonly got: number | null;
  /**
   * Whether the same number reached the lesson the CHILD is shown. Grading
   * `lesson.ans` alone would audit the calculator and not the answer — the
   * `[STEPS]`/pictorial delimiter collision truncated lessons once while every
   * computed answer stayed correct.
   */
  readonly inTheLesson: boolean;
  readonly ok: boolean;
}

export interface HarnessResponse {
  readonly items: readonly HarnessItem[];
  readonly passed: number;
  readonly total: number;
  readonly ok: boolean;
  /** Parent-facing, and the only place the claim is put into words. */
  readonly note: string;
}

const NOTE =
  'These five sums were worked out by Chittu just now and checked against the '
  + 'answers. No AI was asked: sums are done by a calculator built into Chittu, '
  + 'which is why the answer is the same every time.';

/**
 * @param items injected so a test can hand in a WRONG truth and confirm the
 *   harness reports a failure. A harness that cannot fail is not a harness.
 */
export function runMathsHarness(
  ctx: MathContext,
  items: readonly HarnessProblem[] = HARNESS_ITEMS,
): HarnessResponse {
  const results = items.map((p): HarnessItem => {
    const turn = mathTurn(p.ask, ctx);
    // Not arithmetic, or division by zero: `ans` is the string 'undefined'.
    // Either way there is no number, and "no answer" is never a pass.
    const got = turn === null || typeof turn.lesson.ans !== 'number' ? null : turn.lesson.ans;
    // `endsWith`, not `includes`: the number sentence is the only step that ENDS
    // with the answer, and `includes('= 8')` would also be satisfied by a lesson
    // reading "= 80".
    const inTheLesson = got !== null && turn !== null
      && turn.lesson.steps.some((s) => s.endsWith(`= ${got}`));
    return { shown: p.shown, truth: p.truth, got, inTheLesson, ok: got === p.truth && inTheLesson };
  });

  const passed = results.filter((r) => r.ok).length;
  return {
    items: results,
    passed,
    total: results.length,
    ok: passed === results.length,
    note: NOTE,
  };
}
