/**
 * @chittu/maths-engine — the deterministic arithmetic engine and its
 * Concrete-Pictorial-Abstract lesson builder.
 *
 * Ported from prototype/chittu-v3.html (tryMath/calc/pictorial/buildMathLesson/
 * genPractice/askPractice at lines 525-599; the practice loop at lines 1060-1101).
 * Semantics are ported, not rewritten: where the prototype is odd, the oddity is
 * preserved and pinned by a test marked PROTOTYPE QUIRK.
 *
 * "Pure arithmetic is answered by the deterministic engine — never routed to a
 * model" (CLAUDE.md). Every function here is pure: same inputs, same lesson, no
 * clock, no randomness, no I/O. That is what makes the maths path auditable and
 * what makes it a zero-token path.
 *
 * The prototype read the child's band, board and name off the global `S`, and
 * `askPractice` wrote the next question back into `S.mathPractice`. Those reads
 * become explicit parameters and that write becomes a returned value — the only
 * change of shape in this port.
 */
import type { Band } from '@chittu/contracts';

// ---------------------------------------------------------------------------
// The two separators. They collided once and truncated lessons (CLAUDE.md).
// ---------------------------------------------------------------------------

/** `[STEPS]` items are joined with this. Also the chip separator. */
export const STEPS_SEPARATOR = '|';

/**
 * Maths pictorial emoji groups are joined with this MIDDLE DOT (U+00B7), never
 * with `|`. Swapping the two makes every pictorial row read as a separate step
 * and truncates the lesson at the first group.
 */
export const PICTORIAL_SEPARATOR = '·';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MathOp = '+' | '-' | '*' | '/';

/** What the parser recovers from a child's sentence. */
export interface MathExpr {
  readonly a: number;
  readonly op: MathOp;
  readonly b: number;
}

/** A generated follow-up question plus the answer it is checked against. */
export interface MathPractice {
  /** The question as shown to the child, e.g. "3 × 5". */
  readonly q: string;
  readonly a: number;
  readonly op: MathOp;
  readonly b: number;
  readonly ans: number;
}

export interface MathLesson {
  readonly steps: readonly string[];
  /** The literal string 'undefined' on division by zero — the prototype's value. */
  readonly ans: number | 'undefined';
  readonly practice: MathPractice | null;
}

/** What the lesson builder needs off the session. */
export interface LessonContext {
  readonly band: Band;
  /** Curriculum board key ('SG', 'IB', …). Unknown keys simply get no method line. */
  readonly board: string;
}

/** Adds the child's first name, used only when asking the practice question. */
export interface MathContext extends LessonContext {
  readonly kid: string;
}

/** One turn inside the practice loop. */
export type PracticeStep =
  | {
      readonly handled: true;
      readonly reply: string;
      readonly trace: string;
      /** Loop state AFTER this turn — null once the child leaves the loop. */
      readonly practice: MathPractice | null;
      /** The prototype's `S.topics.add('maths')`, which only the answer branch does. */
      readonly topicMaths: boolean;
    }
  | {
      /**
       * Prototype line 1090: the child said something that is neither an answer
       * nor a loop command, so the loop is released and the turn continues down
       * the rest of the pipeline.
       */
      readonly handled: false;
      readonly practice: null;
    };

/** A pure-arithmetic turn answered without a model. */
export interface MathTurn {
  readonly lesson: MathLesson;
  readonly reply: string;
  readonly trace: string;
  readonly practice: MathPractice | null;
  readonly topicMaths: true;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Recovers a single binary arithmetic expression from a child's sentence, or
 * null. Only a lone `a op b` counts — anything else (three terms, words, an
 * unparsed operator) falls through to the rest of the pipeline.
 *
 * The replace chain and the match pattern are byte-for-byte the prototype's,
 * including the lookbehind that only turns `x` into `×` when it sits between
 * two digits (so "six" and "xylophone" survive).
 */
export function tryMath(text: string): MathExpr | null {
  const t = text
    .toLowerCase()
    .replace(/what is|what's|whats|solve|calculate|=|\?/g, ' ')
    .replace(/×|(?<=\d\s?)x(?=\s?\d)/g, '*')
    .replace(/÷/g, '/')
    .replace(/plus/g, '+')
    .replace(/minus/g, '-')
    .replace(/times/g, '*')
    .replace(/divided by/g, '/')
    .trim();
  const m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*([+\-*\/])\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  // The three groups are unconditional in the pattern, so the casts hold; TS
  // widens every group to `string | undefined` regardless.
  return { a: parseFloat(m[1] as string), op: m[2] as MathOp, b: parseFloat(m[3] as string) };
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Child-facing operator glyphs: true minus, times and obelus, not ASCII. */
export const SYM: Readonly<Record<MathOp, string>> = Object.freeze({
  '+': '+',
  '-': '−',
  '*': '×',
  '/': '÷',
});

/**
 * The whole of Chittu's arithmetic. Exact when the result is an integer;
 * otherwise rounded to 2 decimal places, which is also what keeps float noise
 * (0.1 + 0.2) out of a child's answer.
 */
export function calc(a: number, op: MathOp, b: number): number {
  const v = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b;
  return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Pedagogy: Concrete → Pictorial → Abstract
// ---------------------------------------------------------------------------

/** Board-specific concrete method. Boards absent here get no method line. */
export const MATH_METHOD: Readonly<Record<string, string>> = Object.freeze({
  SG: 'the Singapore bar model — draw a bar and cut it into equal parts',
  'Common Core': 'number bonds and area models, the Common Core way',
  IB: 'a wondering question first — what do YOU notice about these numbers?',
  Montessori: 'real objects you can touch and count — beads, buttons, blocks',
});

/**
 * The picture the child can count. Returns null when the numbers are too big to
 * draw — the lesson then goes straight from story to number sentence.
 */
export function pictorial(a: number, op: MathOp, b: number, band: Band): string | null {
  const e = band === 'explorer' ? '🥭' : '⭐';
  if (op === '*' && a <= 5 && b <= 6)
    return (
      Array.from({ length: a }, () => e.repeat(b)).join('   ' + PICTORIAL_SEPARATOR + '   ') +
      '  — count them all!'
    );
  if (op === '+' && a <= 10 && b <= 10) return '●'.repeat(a) + '  +  ' + '●'.repeat(b);
  if (op === '-' && a <= 12 && b < a)
    return '●'.repeat(a - b) + '○'.repeat(b) + '  — the empty ones went away!';
  if (op === '/' && b <= 5 && a <= 20 && Number.isInteger(a / b))
    return b + ' friends get ' + e.repeat(a / b) + ' each';
  return null;
}

/**
 * meaning → story → pictorial → board method → number sentence → why it works.
 *
 * Explorers (4-7) get the shortened lesson: no board method, no why-it-works.
 * Builders and thinkers get the full six.
 */
export function buildMathLesson(
  a: number,
  op: MathOp,
  b: number,
  ctx: LessonContext,
): MathLesson {
  if (op === '/' && b === 0)
    return {
      steps: [
        'Dividing by zero is not allowed — you cannot share among zero friends! There is no answer.',
      ],
      ans: 'undefined',
      practice: null,
    };
  const ans = calc(a, op, b);
  const meaning: Record<MathOp, string> = {
    '+': 'Adding means putting together',
    '-': 'Subtracting means finding what is left',
    '*': a + ' × ' + b + ' means ' + a + ' groups of ' + b,
    '/': 'Dividing means fair sharing',
  };
  const story: Record<MathOp, string> = {
    '+': 'You have ' + a + ' stickers and win ' + b + ' more',
    '-': a + ' laddus on the plate — ' + b + ' get eaten',
    '*': 'Imagine ' + a + ' baskets with ' + b + ' mangoes in each',
    '/': a + ' chocolates shared fairly among ' + b + ' friends',
  };
  const why: Record<MathOp, string> = {
    '*':
      'Why it works: ' + a + ' × ' + b + ' is just ' + b + ' added ' + a +
      ' times — multiplication is speedy adding!',
    '/':
      'Why it works: division is the opposite of multiplication — because ' +
      b + ' × ' + ans + ' = ' + a + '!',
    '-': 'Check it: ' + ans + ' + ' + b + ' takes you right back to ' + a + '!',
    '+': 'Check it: ' + ans + ' − ' + b + ' takes you right back to ' + a + '!',
  };
  const pic = pictorial(a, op, b, ctx.band);
  const method = MATH_METHOD[ctx.board];
  let steps = [meaning[op], story[op]];
  if (pic) steps.push(pic);
  if (method && ctx.band !== 'explorer') steps.push('Try it with ' + method);
  steps.push('So: ' + a + ' ' + SYM[op] + ' ' + b + ' = ' + ans);
  if (ctx.band !== 'explorer') steps.push(why[op]);
  if (ctx.band === 'explorer')
    steps = steps
      .slice(0, 4)
      .concat(['So: ' + a + ' ' + SYM[op] + ' ' + b + ' = ' + ans])
      .filter((v, i, arr) => arr.indexOf(v) === i);
  return { steps, ans, practice: genPractice(a, op, b) };
}

// ---------------------------------------------------------------------------
// Practice loop
// ---------------------------------------------------------------------------

/** A neighbouring problem: same shape, one step harder, still exactly checkable. */
export function genPractice(a: number, op: MathOp, b: number): MathPractice {
  let na = a,
    nb = b;
  if (op === '*') {
    nb = b < 12 ? b + 1 : b - 1;
  } else if (op === '+') {
    nb = b + 1;
  } else if (op === '-') {
    na = a + 2;
    if (na <= nb) na = nb + 2;
  } else {
    const q = Math.floor(a / b) + 1;
    na = b * q;
  }
  return { q: na + ' ' + SYM[op] + ' ' + nb, a: na, op, b: nb, ans: calc(na, op, nb) };
}

/**
 * The invitation to try one. The caller stores `pr` as the loop state — the
 * prototype's `askPractice` did that write itself, off the global.
 */
export function askPractice(pr: MathPractice, kid: string): string {
  return (
    ' Now YOUR turn, ' + kid + '! What is ' + pr.q +
    '? Type your answer! [CHIPS]Show me how|Another one|I’m done[/CHIPS]'
  );
}

/**
 * One turn while a practice question is outstanding. The typed answer is
 * checked EXACTLY (`parseFloat(text) === ans`) — no tolerance, no model.
 *
 * A wrong answer does not end the loop: the same question stays open behind a
 * guided reteach, which is the whole point of the loop.
 */
export function practiceStep(
  practice: MathPractice,
  text: string,
  ctx: MathContext,
): PracticeStep {
  const tt = text.trim();
  const pr = practice;
  if (/^-?\d+(\.\d+)?$/.test(tt)) {
    if (parseFloat(tt) === pr.ans) {
      const next = genPractice(pr.a, pr.op, pr.b);
      return {
        handled: true,
        reply:
          '[BIG]🏆[/BIG] YES! ' + pr.q + ' = ' + pr.ans + ' — you got it, ' + ctx.kid +
          '! You are becoming a maths star! ⭐' + askPractice(next, ctx.kid),
        trace: 'MATH ENGINE · practice ✓ correct',
        practice: next,
        topicMaths: true,
      };
    }
    const lesson = buildMathLesson(pr.a, pr.op, pr.b, ctx);
    return {
      handled: true,
      reply:
        'Good try! Not ' + tt + ' — let’s see it together: [STEPS]' +
        lesson.steps.join(STEPS_SEPARATOR) +
        '[/STEPS] Try once more — type your answer! [CHIPS]Show me how|New one please|I’m done[/CHIPS]',
      trace: 'MATH ENGINE · practice · guided reteach',
      practice: pr,
      topicMaths: true,
    };
  }
  if (/show me how/i.test(tt)) {
    const lesson = buildMathLesson(pr.a, pr.op, pr.b, ctx);
    return {
      handled: true,
      reply:
        'Here’s how! [STEPS]' + lesson.steps.join(STEPS_SEPARATOR) +
        '[/STEPS] Now type the answer! 💪',
      trace: 'MATH ENGINE · pedagogy reteach',
      practice: pr,
      topicMaths: false,
    };
  }
  if (/another one|new one/i.test(tt)) {
    const next = genPractice(pr.a, pr.op, pr.b);
    return {
      handled: true,
      reply: 'Fresh one coming up! [BIG]🔢[/BIG]' + askPractice(next, ctx.kid),
      trace: 'MATH ENGINE · new practice',
      practice: next,
      topicMaths: false,
    };
  }
  if (/i'?m done|back to fun|stop/i.test(tt)) {
    return {
      handled: true,
      reply:
        'Wonderful practising, ' + ctx.kid +
        '! Your brain did push-ups today! [BIG]🧠[/BIG] [CHIPS]Fun fact!|Tell a story!|Quiz me![/CHIPS]',
      trace: 'MATH ENGINE · practice done',
      practice: null,
      topicMaths: false,
    };
  }
  return { handled: false, practice: null };
}

// ---------------------------------------------------------------------------
// The layer itself
// ---------------------------------------------------------------------------

/**
 * The MATH_ENGINE pipeline layer: null when the text is not pure arithmetic, so
 * the caller falls through to corpus/classifier/sandbox. Never a model call.
 *
 * The reply is the prototype's block-grammar string; the caller parses it into
 * Blocks exactly as it does every other reply.
 */
export function mathTurn(text: string, ctx: MathContext): MathTurn | null {
  const mm = tryMath(text);
  if (!mm) return null;
  const lesson = buildMathLesson(mm.a, mm.op, mm.b, ctx);
  const tail = lesson.practice
    ? askPractice(lesson.practice, ctx.kid)
    : ' [CHIPS]Another one!|I’m done[/CHIPS]';
  return {
    lesson,
    reply:
      'Let’s LEARN it, not just answer it! [BIG]🔢[/BIG] [STEPS]' +
      lesson.steps.join(STEPS_SEPARATOR) + '[/STEPS]' + tail,
    trace: 'MATH ENGINE · deterministic + pedagogy (CPA)',
    practice: lesson.practice,
    topicMaths: true,
  };
}
