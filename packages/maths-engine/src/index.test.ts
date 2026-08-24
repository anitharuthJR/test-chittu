/**
 * Every expected value here was taken from the prototype's own functions, run
 * over the same inputs (a differential harness of 72k cases, ref = the code
 * extracted verbatim from prototype/chittu-v3.html). Cases marked PROTOTYPE
 * QUIRK are pinned deliberately: they preserve behaviour that looks wrong, so a
 * future fix has to be a decision rather than an accident.
 */
import { describe, expect, it } from 'vitest';
import type { LessonContext, MathContext, MathOp } from './index.js';
import {
  askPractice,
  buildMathLesson,
  calc,
  genPractice,
  mathTurn,
  MATH_METHOD,
  PICTORIAL_SEPARATOR,
  pictorial,
  practiceStep,
  STEPS_SEPARATOR,
  SYM,
  tryMath,
} from './index.js';

const explorer: MathContext = { band: 'explorer', board: 'General', kid: 'Meera' };
const builder: MathContext = { band: 'builder', board: 'General', kid: 'Meera' };
const thinker: MathContext = { band: 'thinker', board: 'General', kid: 'Meera' };
const builderSG: MathContext = { band: 'builder', board: 'SG', kid: 'Meera' };

/** The text between [STEPS] and [/STEPS] in a rendered reply. */
function stepsBlock(reply: string): string {
  const m = /\[STEPS\]([\s\S]*)\[\/STEPS\]/.exec(reply);
  expect(m).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

// ---------------------------------------------------------------------------
// tryMath — the parser
// ---------------------------------------------------------------------------

describe('tryMath', () => {
  it('parses the four operators from plain digits', () => {
    expect(tryMath('3+4')).toEqual({ a: 3, op: '+', b: 4 });
    expect(tryMath('9-3')).toEqual({ a: 9, op: '-', b: 3 });
    expect(tryMath('6*7')).toEqual({ a: 6, op: '*', b: 7 });
    expect(tryMath('100/7')).toEqual({ a: 100, op: '/', b: 7 });
  });

  it('strips the question wrapper words, the equals sign and the question mark', () => {
    expect(tryMath('what is 3+4')).toEqual({ a: 3, op: '+', b: 4 });
    expect(tryMath("what's 12 times 3")).toEqual({ a: 12, op: '*', b: 3 });
    expect(tryMath('whats 12 times 3')).toEqual({ a: 12, op: '*', b: 3 });
    expect(tryMath('solve 100/7')).toEqual({ a: 100, op: '/', b: 7 });
    expect(tryMath('calculate 8*8?')).toEqual({ a: 8, op: '*', b: 8 });
    expect(tryMath('2 plus 2 = ?')).toEqual({ a: 2, op: '+', b: 2 });
  });

  it('reads the word operators', () => {
    expect(tryMath('5 plus 6')).toEqual({ a: 5, op: '+', b: 6 });
    expect(tryMath('7 minus 2')).toEqual({ a: 7, op: '-', b: 2 });
    expect(tryMath('12 times 3')).toEqual({ a: 12, op: '*', b: 3 });
    expect(tryMath('10 divided by 2')).toEqual({ a: 10, op: '/', b: 2 });
  });

  it('reads the typographic operators and a digit-hugging x', () => {
    expect(tryMath('3 × 4')).toEqual({ a: 3, op: '*', b: 4 });
    expect(tryMath('12 ÷ 4')).toEqual({ a: 12, op: '/', b: 4 });
    expect(tryMath('3x4')).toEqual({ a: 3, op: '*', b: 4 });
    expect(tryMath('3 x 4')).toEqual({ a: 3, op: '*', b: 4 });
  });

  it('leaves an x that is not between two digits alone', () => {
    // The lookbehind/lookahead allow at most ONE space on each side.
    expect(tryMath('3  x  4')).toBeNull();
    expect(tryMath('xylophone')).toBeNull();
    expect(tryMath('six plus two')).toBeNull();
  });

  it('handles decimals, negatives and upper case', () => {
    expect(tryMath('2.5 + 1.5')).toEqual({ a: 2.5, op: '+', b: 1.5 });
    expect(tryMath('-5 + 3')).toEqual({ a: -5, op: '+', b: 3 });
    expect(tryMath('5 - -2')).toEqual({ a: 5, op: '-', b: -2 });
    expect(tryMath('WHAT IS 9-3')).toEqual({ a: 9, op: '-', b: 3 });
    expect(tryMath('  6 * 7  ')).toEqual({ a: 6, op: '*', b: 7 });
  });

  it('returns null for anything that is not one binary expression', () => {
    expect(tryMath('tell me a story')).toBeNull();
    expect(tryMath('3 + 4 + 5')).toBeNull(); // only a single a-op-b is deterministic
    expect(tryMath('what is love')).toBeNull();
    expect(tryMath('surplus 3')).toBeNull(); // "plus" inside a word leaves "sur+ 3"
    expect(tryMath('how many times do i')).toBeNull();
  });

  it('parses division by zero rather than rejecting it — the lesson handles it', () => {
    expect(tryMath('10 divided by 0')).toEqual({ a: 10, op: '/', b: 0 });
  });

  it('PROTOTYPE QUIRK: reads back its own × and ÷ but not its own minus', () => {
    // Lessons print SYM['-'] = '−' (U+2212), which the replace chain never maps
    // to '-', so a child re-typing the printed sentence gets no engine answer.
    expect(tryMath('3 × 5')).toEqual({ a: 3, op: '*', b: 5 });
    expect(tryMath('12 ÷ 4')).toEqual({ a: 12, op: '/', b: 4 });
    expect(tryMath(`9 ${SYM['-']} 2`)).toBeNull();
    expect(tryMath('9 - 2')).toEqual({ a: 9, op: '-', b: 2 });
  });
});

// ---------------------------------------------------------------------------
// calc — the whole of the arithmetic
// ---------------------------------------------------------------------------

describe('calc', () => {
  it('does the four operations', () => {
    expect(calc(1, '+', 2)).toBe(3);
    expect(calc(5, '-', 8)).toBe(-3);
    expect(calc(3, '*', 4)).toBe(12);
    expect(calc(12, '/', 4)).toBe(3);
  });

  it('keeps integer results exact', () => {
    expect(calc(1e10, '*', 3)).toBe(3e10);
    expect(Number.isInteger(calc(7, '-', 7))).toBe(true);
  });

  it('rounds non-integer results to 2 decimal places', () => {
    expect(calc(10, '/', 4)).toBe(2.5);
    expect(calc(10, '/', 3)).toBe(3.33);
    expect(calc(2, '/', 3)).toBe(0.67);
    expect(calc(100, '/', 7)).toBe(14.29);
    expect(calc(2.5, '*', 3)).toBe(7.5);
  });

  it('rounds float noise away, which is why 0.1 + 0.2 reads as 0.3 to a child', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the reason the rounding rule exists
    expect(calc(0.1, '+', 0.2)).toBe(0.3);
  });

  it('PROTOTYPE QUIRK: division by zero returns Infinity / NaN from calc itself', () => {
    // Safe only because buildMathLesson intercepts b === 0 before calling calc.
    expect(calc(5, '/', 0)).toBe(Infinity);
    expect(Number.isNaN(calc(0, '/', 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pictorial — the picture the child can count
// ---------------------------------------------------------------------------

describe('pictorial', () => {
  it('draws multiplication as groups joined by the MIDDLE DOT', () => {
    expect(pictorial(3, '*', 4, 'builder')).toBe(
      '⭐⭐⭐⭐   ·   ⭐⭐⭐⭐   ·   ⭐⭐⭐⭐  — count them all!',
    );
  });

  it('gives explorers mangoes and everyone else stars', () => {
    expect(pictorial(3, '*', 4, 'explorer')).toBe(
      '🥭🥭🥭🥭   ·   🥭🥭🥭🥭   ·   🥭🥭🥭🥭  — count them all!',
    );
    expect(pictorial(3, '*', 4, 'thinker')).toContain('⭐');
    expect(pictorial(12, '/', 3, 'explorer')).toBe('3 friends get 🥭🥭🥭🥭 each');
  });

  it('draws addition and subtraction with filled and empty circles', () => {
    expect(pictorial(3, '+', 4, 'builder')).toBe('●●●  +  ●●●●');
    expect(pictorial(10, '-', 4, 'builder')).toBe('●●●●●●○○○○  — the empty ones went away!');
  });

  it('returns null once the numbers are too big to draw', () => {
    expect(pictorial(6, '*', 2, 'builder')).toBeNull(); // a > 5
    expect(pictorial(3, '*', 7, 'builder')).toBeNull(); // b > 6
    expect(pictorial(11, '+', 1, 'builder')).toBeNull(); // a > 10
    expect(pictorial(1, '+', 11, 'builder')).toBeNull(); // b > 10
    expect(pictorial(13, '-', 2, 'builder')).toBeNull(); // a > 12
    expect(pictorial(4, '-', 9, 'builder')).toBeNull(); // b >= a, nothing to cross out
    expect(pictorial(24, '/', 2, 'builder')).toBeNull(); // a > 20
    expect(pictorial(12, '/', 7, 'builder')).toBeNull(); // b > 5
    expect(pictorial(12, '/', 5, 'builder')).toBeNull(); // not a whole share
  });

  it('PROTOTYPE QUIRK: a fractional left operand draws fewer groups than the answer', () => {
    // 2.5 × 3 = 7.5 but Array.from({length: 2.5}) yields 2 groups of 3.
    expect(pictorial(2.5, '*', 3, 'explorer')).toBe('🥭🥭🥭   ·   🥭🥭🥭  — count them all!');
    expect(calc(2.5, '*', 3)).toBe(7.5);
  });

  it('PROTOTYPE QUIRK: a negative left operand draws an empty multiplication', () => {
    expect(pictorial(-3, '*', 2, 'builder')).toBe('  — count them all!');
  });

  it('PROTOTYPE QUIRK: negative operands throw RangeError out of String.repeat', () => {
    // Reachable from a child typing "-3 + 2": tryMath parses it, the lesson
    // builder calls pictorial, and repeat(-3) throws. Ported, not fixed.
    expect(() => pictorial(-3, '+', 2, 'builder')).toThrow(RangeError);
    expect(() => pictorial(5, '-', -2, 'builder')).toThrow(RangeError);
    expect(() => pictorial(3, '*', -2, 'builder')).toThrow(RangeError);
    expect(() => pictorial(-10, '/', 5, 'builder')).toThrow(RangeError);
    expect(() => buildMathLesson(-3, '+', 2, builder)).toThrow(RangeError);
    expect(() => mathTurn('-3 + 2', builder)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// buildMathLesson — meaning, story, picture, method, sentence, why
// ---------------------------------------------------------------------------

describe('buildMathLesson', () => {
  it('teaches builders the full six steps in order', () => {
    expect(buildMathLesson(3, '*', 4, builderSG)).toEqual({
      steps: [
        '3 × 4 means 3 groups of 4',
        'Imagine 3 baskets with 4 mangoes in each',
        '⭐⭐⭐⭐   ·   ⭐⭐⭐⭐   ·   ⭐⭐⭐⭐  — count them all!',
        'Try it with the Singapore bar model — draw a bar and cut it into equal parts',
        'So: 3 × 4 = 12',
        'Why it works: 3 × 4 is just 4 added 3 times — multiplication is speedy adding!',
      ],
      ans: 12,
      practice: { q: '3 × 5', a: 3, op: '*', b: 5, ans: 15 },
    });
  });

  it('gives thinkers the why-it-works line too', () => {
    const l = buildMathLesson(7, '-', 2, thinker);
    expect(l.steps).toEqual([
      'Subtracting means finding what is left',
      '7 laddus on the plate — 2 get eaten',
      '●●●●●○○  — the empty ones went away!',
      'So: 7 − 2 = 5',
      'Check it: 5 + 2 takes you right back to 7!',
    ]);
  });

  it('shortens the lesson for explorers: no board method, no why-it-works', () => {
    const l = buildMathLesson(3, '*', 4, { band: 'explorer', board: 'SG' });
    expect(l.steps).toEqual([
      '3 × 4 means 3 groups of 4',
      'Imagine 3 baskets with 4 mangoes in each',
      '🥭🥭🥭🥭   ·   🥭🥭🥭🥭   ·   🥭🥭🥭🥭  — count them all!',
      'So: 3 × 4 = 12',
    ]);
    expect(l.steps.some((s) => s.startsWith('Try it with'))).toBe(false);
    expect(l.steps.some((s) => s.startsWith('Why it works') || s.startsWith('Check it'))).toBe(
      false,
    );
  });

  it('ends an explorer lesson on the number sentence exactly once', () => {
    // The explorer branch re-appends "So: …" and then dedupes; it must not double.
    const l = buildMathLesson(100, '+', 200, { band: 'explorer', board: 'SG' });
    expect(l.steps).toEqual([
      'Adding means putting together',
      'You have 100 stickers and win 200 more',
      'So: 100 + 200 = 300',
    ]);
    expect(l.steps.filter((s) => s === 'So: 100 + 200 = 300')).toHaveLength(1);
  });

  it('adds the board method only for a board that has one', () => {
    const withMethod = (board: string): boolean =>
      buildMathLesson(3, '*', 4, { band: 'builder', board }).steps.some((s) =>
        s.startsWith('Try it with'),
      );
    expect(withMethod('SG')).toBe(true);
    expect(withMethod('Common Core')).toBe(true);
    expect(withMethod('IB')).toBe(true);
    expect(withMethod('Montessori')).toBe(true);
    expect(withMethod('General')).toBe(false);
    expect(withMethod('TN')).toBe(false);
    expect(Object.keys(MATH_METHOD)).toEqual(['SG', 'Common Core', 'IB', 'Montessori']);
  });

  it('drops the picture when the numbers are too big, keeping the rest of the shape', () => {
    const l = buildMathLesson(100, '/', 7, thinker);
    expect(l.steps).toEqual([
      'Dividing means fair sharing',
      '100 chocolates shared fairly among 7 friends',
      'So: 100 ÷ 7 = 14.29',
      'Why it works: division is the opposite of multiplication — because 7 × 14.29 = 100!',
    ]);
    expect(l.ans).toBe(14.29);
  });

  it('reports a non-integer answer through the rounding rule', () => {
    const l = buildMathLesson(10, '/', 4, thinker);
    expect(l.ans).toBe(2.5);
    expect(l.steps).toContain('So: 10 ÷ 4 = 2.5');
  });

  it('refuses division by zero with a scripted step and no practice', () => {
    for (const ctx of [explorer, builder, thinker]) {
      expect(buildMathLesson(8, '/', 0, ctx)).toEqual({
        steps: [
          'Dividing by zero is not allowed — you cannot share among zero friends! There is no answer.',
        ],
        ans: 'undefined',
        practice: null,
      });
    }
  });

  it('uses the child-facing operator glyphs, not ASCII', () => {
    expect(SYM).toEqual({ '+': '+', '-': '−', '*': '×', '/': '÷' });
    expect(SYM['-']).toBe('−'); // true minus, not hyphen
    expect(SYM['*']).toBe('×');
    expect(SYM['/']).toBe('÷');
  });
});

// ---------------------------------------------------------------------------
// genPractice / askPractice
// ---------------------------------------------------------------------------

describe('genPractice', () => {
  it('nudges multiplication one table up, and back down at 12', () => {
    expect(genPractice(3, '*', 4)).toEqual({ q: '3 × 5', a: 3, op: '*', b: 5, ans: 15 });
    expect(genPractice(3, '*', 12)).toEqual({ q: '3 × 11', a: 3, op: '*', b: 11, ans: 33 });
  });

  it('nudges addition by one', () => {
    expect(genPractice(2, '+', 3)).toEqual({ q: '2 + 4', a: 2, op: '+', b: 4, ans: 6 });
  });

  it('keeps subtraction positive by lifting the left number above the right', () => {
    expect(genPractice(9, '-', 4)).toEqual({ q: '11 − 4', a: 11, op: '-', b: 4, ans: 7 });
    // a + 2 would still not clear b, so it jumps to b + 2 instead.
    expect(genPractice(3, '-', 5)).toEqual({ q: '7 − 5', a: 7, op: '-', b: 5, ans: 2 });
  });

  it('rounds division up to the next whole share so the answer stays exact', () => {
    expect(genPractice(12, '/', 4)).toEqual({ q: '16 ÷ 4', a: 16, op: '/', b: 4, ans: 4 });
    expect(genPractice(10, '/', 4)).toEqual({ q: '12 ÷ 4', a: 12, op: '/', b: 4, ans: 3 });
  });

  it('PROTOTYPE QUIRK: a zero divisor yields a NaN question', () => {
    // Unreachable in practice — buildMathLesson returns before generating one —
    // but genPractice itself does not guard b === 0.
    const p = genPractice(5, '/', 0);
    expect(Number.isNaN(p.a)).toBe(true);
    expect(p.q).toBe('NaN ÷ 0');
  });
});

describe('askPractice', () => {
  it('asks with the child’s name and the three chips', () => {
    expect(askPractice(genPractice(3, '*', 4), 'Meera')).toBe(
      ' Now YOUR turn, Meera! What is 3 × 5? Type your answer!' +
        ' [CHIPS]Show me how|Another one|I’m done[/CHIPS]',
    );
  });
});

// ---------------------------------------------------------------------------
// practiceStep — the loop
// ---------------------------------------------------------------------------

describe('practiceStep', () => {
  const pr = genPractice(3, '*', 4); // 3 × 5 = 15

  it('celebrates an exactly correct answer and opens the next question', () => {
    const s = practiceStep(pr, '15', builderSG);
    expect(s).toEqual({
      handled: true,
      reply:
        '[BIG]🏆[/BIG] YES! 3 × 5 = 15 — you got it, Meera! You are becoming a maths star! ⭐' +
        ' Now YOUR turn, Meera! What is 3 × 6? Type your answer!' +
        ' [CHIPS]Show me how|Another one|I’m done[/CHIPS]',
      trace: 'MATH ENGINE · practice ✓ correct',
      practice: { q: '3 × 6', a: 3, op: '*', b: 6, ans: 18 },
      topicMaths: true,
    });
  });

  it('accepts surrounding whitespace but nothing else around the number', () => {
    expect(practiceStep(pr, '  15  ', builderSG).handled).toBe(true);
    const notANumber = practiceStep(pr, '15abc', builderSG);
    expect(notANumber.handled).toBe(false); // falls through, loop released
  });

  it('checks the answer EXACTLY — near enough is not enough', () => {
    const half = { q: '10 ÷ 4', a: 10, op: '/' as MathOp, b: 4, ans: 2.5 };
    expect(practiceStep(half, '2.5', builderSG).handled).toBe(true);
    expect(
      (practiceStep(half, '2.5', builderSG) as { trace: string }).trace,
    ).toBe('MATH ENGINE · practice ✓ correct');
    const near = practiceStep(half, '3', builderSG) as { trace: string; reply: string };
    expect(near.trace).toBe('MATH ENGINE · practice · guided reteach');
    expect(near.reply).toContain('Good try! Not 3');
  });

  it('reteaches a wrong answer and KEEPS the same question open', () => {
    const s = practiceStep(pr, '9', builderSG);
    expect(s).toEqual({
      handled: true,
      reply:
        'Good try! Not 9 — let’s see it together: [STEPS]' +
        '3 × 5 means 3 groups of 5|' +
        'Imagine 3 baskets with 5 mangoes in each|' +
        '⭐⭐⭐⭐⭐   ·   ⭐⭐⭐⭐⭐   ·   ⭐⭐⭐⭐⭐  — count them all!|' +
        'Try it with the Singapore bar model — draw a bar and cut it into equal parts|' +
        'So: 3 × 5 = 15|' +
        'Why it works: 3 × 5 is just 5 added 3 times — multiplication is speedy adding!' +
        '[/STEPS] Try once more — type your answer!' +
        ' [CHIPS]Show me how|New one please|I’m done[/CHIPS]',
      trace: 'MATH ENGINE · practice · guided reteach',
      practice: pr,
      topicMaths: true,
    });
  });

  it('reteaches on request without counting as an attempt', () => {
    const s = practiceStep(pr, 'Show me HOW', builderSG);
    expect(s).toMatchObject({
      handled: true,
      trace: 'MATH ENGINE · pedagogy reteach',
      practice: pr,
      topicMaths: false,
    });
    expect((s as { reply: string }).reply).toContain('Here’s how! [STEPS]');
    expect((s as { reply: string }).reply).toContain('Now type the answer! 💪');
  });

  it('swaps in a fresh question on "another one" or "new one please"', () => {
    const next = { q: '3 × 6', a: 3, op: '*', b: 6, ans: 18 };
    for (const said of ['another one', 'Another one!', 'New one please']) {
      expect(practiceStep(pr, said, builderSG)).toEqual({
        handled: true,
        reply:
          'Fresh one coming up! [BIG]🔢[/BIG]' +
          ' Now YOUR turn, Meera! What is 3 × 6? Type your answer!' +
          ' [CHIPS]Show me how|Another one|I’m done[/CHIPS]',
        trace: 'MATH ENGINE · new practice',
        practice: next,
        topicMaths: false,
      });
    }
  });

  it('lets the child leave with no guilt and no streak talk', () => {
    for (const said of ["I'm done", 'im done', 'back to fun', 'stop']) {
      const s = practiceStep(pr, said, builderSG);
      expect(s).toEqual({
        handled: true,
        reply:
          'Wonderful practising, Meera! Your brain did push-ups today! [BIG]🧠[/BIG]' +
          ' [CHIPS]Fun fact!|Tell a story!|Quiz me![/CHIPS]',
        trace: 'MATH ENGINE · practice done',
        practice: null,
        topicMaths: false,
      });
      // No engagement mechanics anywhere (CLAUDE.md).
      expect((s as { reply: string }).reply).not.toMatch(/streak|don.t go|come back|miss you/i);
    }
  });

  it('PROTOTYPE QUIRK: the curly-apostrophe chip "I’m done" misses its own regex', () => {
    // askPractice offers "I’m done" (U+2019) but the exit test is /i'?m done/
    // with a straight apostrophe, so the chip falls through to the release path
    // instead of the scripted goodbye. Ported as-is.
    expect(practiceStep(pr, 'I’m done', builderSG)).toEqual({ handled: false, practice: null });
    expect(practiceStep(pr, "I'm done", builderSG).handled).toBe(true);
  });

  it('releases the loop when the child changes the subject', () => {
    expect(practiceStep(pr, 'why do plants need sun', builderSG)).toEqual({
      handled: false,
      practice: null,
    });
  });

  it('reteaches at the band the child is in', () => {
    const e = practiceStep(pr, '9', { band: 'explorer', board: 'SG', kid: 'Meera' });
    const b = practiceStep(pr, '9', builderSG);
    expect((e as { reply: string }).reply).toContain('🥭');
    expect((e as { reply: string }).reply).not.toContain('Why it works');
    expect((b as { reply: string }).reply).toContain('Why it works');
  });
});

// ---------------------------------------------------------------------------
// mathTurn — the MATH_ENGINE layer
// ---------------------------------------------------------------------------

describe('mathTurn', () => {
  it('answers pure arithmetic with a lesson and a practice invitation', () => {
    expect(mathTurn('what is 3 times 4', explorer)).toEqual({
      lesson: buildMathLesson(3, '*', 4, explorer),
      reply:
        'Let’s LEARN it, not just answer it! [BIG]🔢[/BIG] [STEPS]' +
        '3 × 4 means 3 groups of 4|' +
        'Imagine 3 baskets with 4 mangoes in each|' +
        '🥭🥭🥭🥭   ·   🥭🥭🥭🥭   ·   🥭🥭🥭🥭  — count them all!|' +
        'So: 3 × 4 = 12' +
        '[/STEPS] Now YOUR turn, Meera! What is 3 × 5? Type your answer!' +
        ' [CHIPS]Show me how|Another one|I’m done[/CHIPS]',
      trace: 'MATH ENGINE · deterministic + pedagogy (CPA)',
      practice: { q: '3 × 5', a: 3, op: '*', b: 5, ans: 15 },
      topicMaths: true,
    });
  });

  it('falls back to chips when there is no practice to offer', () => {
    const t = mathTurn('8 divided by 0', builder);
    expect(t).toEqual({
      lesson: buildMathLesson(8, '/', 0, builder),
      reply:
        'Let’s LEARN it, not just answer it! [BIG]🔢[/BIG] [STEPS]' +
        'Dividing by zero is not allowed — you cannot share among zero friends! There is no answer.' +
        '[/STEPS] [CHIPS]Another one!|I’m done[/CHIPS]',
      trace: 'MATH ENGINE · deterministic + pedagogy (CPA)',
      practice: null,
      topicMaths: true,
    });
  });

  it('returns null for anything that is not pure arithmetic, so the pipeline continues', () => {
    expect(mathTurn('why is the sky blue', builder)).toBeNull();
    expect(mathTurn('tell me a story', explorer)).toBeNull();
  });

  it('is deterministic: the same question always gives the same lesson', () => {
    expect(mathTurn('12 ÷ 4', thinker)).toEqual(mathTurn('what is 12 divided by 4?', thinker));
  });
});

// ---------------------------------------------------------------------------
// The two separators must never cross (CLAUDE.md — this truncated lessons once)
// ---------------------------------------------------------------------------

describe('separators', () => {
  const ops: MathOp[] = ['+', '-', '*', '/'];
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [3, 4], [10, 4], [12, 3], [5, 6], [2, 3], [100, 7], [20, 5], [1, 1],
  ];
  const ctxs: LessonContext[] = [
    { band: 'explorer', board: 'SG' },
    { band: 'builder', board: 'General' },
    { band: 'thinker', board: 'Montessori' },
    { band: 'builder', board: 'Common Core' },
    { band: 'thinker', board: 'IB' },
  ];

  it('are different characters', () => {
    expect(STEPS_SEPARATOR).toBe('|');
    expect(PICTORIAL_SEPARATOR).toBe('·'); // MIDDLE DOT, not a pipe, not a bullet
    expect(PICTORIAL_SEPARATOR).not.toBe(STEPS_SEPARATOR);
  });

  it('never lets a lesson step contain the [STEPS] separator', () => {
    for (const ctx of ctxs)
      for (const op of ops)
        for (const [a, b] of pairs)
          for (const step of buildMathLesson(a, op, b, ctx).steps)
            expect(step).not.toContain(STEPS_SEPARATOR);
  });

  it('joins pictorial groups with the middle dot only', () => {
    const pic = pictorial(3, '*', 4, 'builder') as string;
    expect(pic).toContain(PICTORIAL_SEPARATOR);
    expect(pic).not.toContain(STEPS_SEPARATOR);
    expect(pic.split(PICTORIAL_SEPARATOR)).toHaveLength(3); // 3 groups of 4
  });

  it('round-trips a rendered [STEPS] block back to the exact step list', () => {
    for (const ctx of ctxs)
      for (const op of ops)
        for (const [a, b] of pairs) {
          // ASCII operators: the parser reads '×' and '÷' but not SYM['-'].
          const turn = mathTurn(`${a} ${op} ${b}`, { ...ctx, kid: 'Meera' });
          expect(turn).not.toBeNull();
          const lesson = (turn as { lesson: { steps: readonly string[] } }).lesson;
          const block = stepsBlock((turn as { reply: string }).reply);
          // Splitting on '|' must recover every step — a pictorial that used '|'
          // instead of '·' would shatter here, which is how lessons truncated.
          expect(block.split(STEPS_SEPARATOR)).toEqual([...lesson.steps]);
        }
  });

  it('keeps the middle dot inside a single step after rendering', () => {
    const reply = (mathTurn('3 × 4', builder) as { reply: string }).reply;
    const items = stepsBlock(reply).split(STEPS_SEPARATOR);
    const pic = items.filter((s) => s.includes(PICTORIAL_SEPARATOR));
    expect(pic).toHaveLength(1);
    expect(pic[0]).toBe('⭐⭐⭐⭐   ·   ⭐⭐⭐⭐   ·   ⭐⭐⭐⭐  — count them all!');
  });

  it('keeps the reteach reply parseable even though its chips also use "|"', () => {
    const pr = genPractice(3, '*', 4);
    const reply = (practiceStep(pr, '9', builderSG) as { reply: string }).reply;
    expect(stepsBlock(reply).split(STEPS_SEPARATOR)).toEqual([
      ...buildMathLesson(3, '*', 5, builderSG).steps,
    ]);
  });
});
