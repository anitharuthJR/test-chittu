/**
 * @chittu/pedagogy — age bands and the universal pedagogy engine.
 *
 * Ported from prototype/chittu-v3.html:
 *   BANDS         lines 414-418
 *   SUBJECT_PED   lines 541-556
 *   detectSubject line 557
 *   fallback line 772 (the `12a. SUBJECT PEDAGOGY:` prompt fragment)
 *
 * Semantics are ported, not rewritten: the regexes are character-for-character
 * copies, the key order is the object literal's order, and every quirk of
 * substring matching is preserved. Pure functions only — no I/O, no state.
 */

import type { Band } from '@chittu/contracts';

// ---------------------------------------------------------------------------
// Bands (prototype lines 414-418)
// ---------------------------------------------------------------------------

export interface BandProfile {
  /** Shown on the chat header chip. */
  readonly label: string;
  /** Prose word cap injected into hard rule 9 of the sandbox prompt. */
  readonly words: number;
  /** Band-specific opening of the sandbox system prompt. */
  readonly sys: string;
}

/**
 * NOTE: `@chittu/contracts` also exports a `BANDS` — that one is the list of
 * band ids, this one is their definitions. Import one of them aliased.
 */
export const BANDS: Readonly<Record<Band, BandProfile>> = Object.freeze({
  explorer: {
    label: '🌱 Explorer (4–7)',
    words: 30,
    sys: 'The child is 4-7. Explain like they are 5: ONE big simple idea, in 2-3 tiny sentences (max 8 words each), using things a small child knows (toys, animals, food, family). Happy words, 2-3 emojis. If a real answer would take longer, give the simplest true first bite and offer to say more.',
  },
  builder: {
    label: '🔧 Builder (8–12)',
    words: 55,
    sys: 'The child is 8-12. Explain like a brilliant older cousin: 2-3 short sentences, one clear idea + one everyday example, playful, 2 emojis. Never a paragraph. Offer a next question via chips.',
  },
  thinker: {
    label: '🔭 Thinker (13–17)',
    words: 75,
    sys: 'The user is a teenager. Explain clearly and honestly in up to 4 short sentences: idea, why it works, one real example. Snappy and respectful, never babyish, 1-2 emojis. Never a paragraph.',
  },
});

// ---------------------------------------------------------------------------
// Subjects (prototype lines 541-557)
// ---------------------------------------------------------------------------

/**
 * Detection order, REGRESSION-LOCKED (CLAUDE.md): languages BEFORE science,
 * because "how do you say…" must not be swallowed by science's `how (do|…)`.
 * The prototype relied on `for (const k in SUBJECT_PED)` walking insertion
 * order; here the order is data so a test can assert it directly.
 */
export const SUBJECT_ORDER = Object.freeze([
  'languages', 'science', 'english', 'history', 'geography', 'coding', 'art',
] as const);

export type Subject = (typeof SUBJECT_ORDER)[number];

export interface SubjectMethod {
  /** Trigger pattern. Named `k` in the prototype; kept so diffs line up. */
  readonly k: RegExp;
  /** The `12a. SUBJECT PEDAGOGY:` line handed to the sandbox prompt. */
  readonly line: string;
}

export const SUBJECT_PED: Readonly<Record<Subject, SubjectMethod>> = Object.freeze({
  languages: {
    k: /spanish|french|hindi|tamil|german|japanese|korean|how (do you|to) say|what does .* mean in|translate|in french|in spanish|in hindi|in tamil/i,
    line: 'NEW-LANGUAGE method (Comprehensible input): give the word + how it SOUNDS (simple phonetic respelling) + use it inside one tiny sentence about the child’s world, then invite them to say/use it once — and offer 2–3 related words as chips for playful recall.',
  },
  science: {
    k: /why|how (do|does|is|can)|what happens|plant|animal|body|space|planet|water|air|light|sound|energy|magnet|volcano|weather|rain|sun|moon|star|insect|bird|dinosaur|electricity|gravity|heart|brain|photosynth|experiment/i,
    line: 'SCIENCE method (Phenomenon-first / Predict-Observe-Explain): open with the surprising real thing, ask the child to PREDICT ("what do you think happens?") before revealing, then explain with a child-world model, and end with a tiny safe try-at-home or look-for-it observation.',
  },
  english: {
    k: /noun|verb|adjective|adverb|grammar|sentence|spelling|plural|tense|punctuation|comma|paragraph|essay|letter writing|synonym|antonym|opposite word/i,
    line: 'LANGUAGE method (Examples-first induction): show 2–3 vivid example sentences FIRST, let the child spot the pattern themselves ("what do you notice?"), only then name the rule, and end by asking them to make ONE sentence of their own.',
  },
  history: {
    k: /history|ancient|king|queen|emperor|empire|war|independence|freedom|gandhi|nehru|chola|ashoka|mughal|british|before people|long ago|olden days|civilization|pyramid/i,
    line: 'HISTORY method (Story-first with people and stakes): tell it as a tiny story of a real person who wanted something, what got in the way, what happened — then one line on why it still matters to the child today, and anchor WHEN with a child-scale comparison ("about 100 grandmas-ago").',
  },
  geography: {
    k: /country|countries|capital|river|mountain|ocean|continent|map|desert|forest|city|state|monsoon|climate|earthquake|where is/i,
    line: 'GEOGRAPHY method (Start where the child stands): begin from the child’s own place and zoom outward, use body-scale comparisons for sizes and distances, and end with "find it on a map with a grown-up" or a look-around observation.',
  },
  coding: {
    k: /code|coding|program|python|scratch|loop|variable|function|algorithm|bug|computer think/i,
    line: 'CODING method (PRIMM-lite): show a tiny working example FIRST, ask the child to PREDICT what it does, explain line by line, then invite them to change ONE small thing ("what if we made it say your name?").',
  },
  art: {
    k: /draw|drawing|paint|colour|color|sketch|craft|origami|art/i,
    line: 'ART method (Shapes-first, process-praise): break the picture into 2–4 simple shapes as [STEPS], encourage looking at the real thing, and praise trying and details — never judge the result.',
  },
});

/** Used when nothing matched (prototype line 772). */
export const NO_SUBJECT_LINE =
  'No specific subject detected — use the universal method (rule 14).';

/**
 * First subject in SUBJECT_ORDER whose pattern matches anywhere in `text`.
 * Substring matching, exactly as the prototype does it — "smart" hits `art`.
 */
export function detectSubject(text: string): Subject | null {
  for (const k of SUBJECT_ORDER) {
    if (SUBJECT_PED[k].k.test(text)) return k;
  }
  return null;
}

/** The prompt fragment for a detected subject, or the universal fallback. */
export function subjectPedagogyLine(subject: Subject | null): string {
  return subject ? SUBJECT_PED[subject].line : NO_SUBJECT_LINE;
}
