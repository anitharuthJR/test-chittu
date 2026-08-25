/**
 * @chittu/reading-coach — the levelled passage bank and the local word scorer.
 *
 * This is the engine behind D2's RM→RC branch and D3's "Reading aloud" row.
 * Two doctrine points govern everything in this file:
 *
 * 1. **Scoring is DETERMINISTIC and LOCAL — no model call, ever.** Same
 *    argument as the maths engine: a scorer that hallucinates a miss teaches a
 *    child they got it wrong when they did not. D3 assigns this row a LOCAL
 *    WORD SCORER and gives it no vendor cell; the router's cell table says the
 *    same ("answered without a model at all... no entry and never will").
 *
 * 2. **The bank is static content, never model-generated.** Every sentence a
 *    child is asked to read was written by a person and shipped with the code.
 *    The bank below is the prototype's (chittu-v3.html:467), ported verbatim —
 *    six Explorer, five Builder, three Thinker. A test asserts every passage
 *    passes the L1 lexicon clean, because a passage that trips a guard would
 *    crisis-lock a child for reading exactly what we asked them to read.
 *
 * What arrives here is TEXT. The browser transcribes the child's voice and
 * discards the audio (the same transcribe-and-discard promise the composer
 * mic makes); no audio is ever stored or sent. And browser ASR is a
 * PLACEHOLDER, not the production path — adult-trained models fail children
 * (status §4); the Phase 2 target is our own child-speech ASR, with Ello- and
 * Amira-class models as the licensing bridge (D3).
 */

import type { Band } from '@chittu/contracts';

export interface ReadPassage {
  readonly id: string;
  readonly band: Band;
  readonly text: string;
}

/**
 * The prototype's READING_BANK (chittu-v3.html:467), verbatim, with stable ids.
 * Ids are the wire contract with the client — never renumber an existing one;
 * append instead.
 */
const BANK_TEXT: Readonly<Record<Band, readonly string[]>> = Object.freeze({
  explorer: [
    'The cat sat on a big red mat.',
    'I can see a bug on the rug.',
    'The sun is up and the sky is blue.',
    'My dog can run and jump and play.',
    'We like to eat a ripe red apple.',
    'The hen has ten little eggs.',
  ],
  builder: [
    'The little sparrow built a cozy nest in the tallest tree.',
    'Yesterday we planted seeds and watered them carefully.',
    'The curious fox followed the winding river to the sea.',
    'Lightning flashed across the sky before the thunder rumbled.',
    'She solved the tricky puzzle by trying one piece at a time.',
  ],
  thinker: [
    'The ancient library held thousands of stories waiting patiently to be discovered.',
    'Although the experiment failed twice, the young scientist refused to give up.',
    'Curiosity, more than talent, is what turns ordinary questions into extraordinary answers.',
  ],
});

export const READING_BANK: readonly ReadPassage[] = Object.freeze(
  (Object.entries(BANK_TEXT) as [Band, readonly string[]][]).flatMap(
    ([band, texts]) => texts.map((text, i) => Object.freeze({
      id: `${band}-${i + 1}`, band, text,
    })),
  ),
);

export function passagesFor(band: Band): readonly ReadPassage[] {
  return READING_BANK.filter((p) => p.band === band);
}

export function passageById(id: string): ReadPassage | null {
  return READING_BANK.find((p) => p.id === id) ?? null;
}

/**
 * The prototype's `normWord` (chittu-v3.html:982), byte-for-byte in behaviour:
 * lowercase, then keep only a–z and the apostrophe. Punctuation, digits and
 * any non-Latin script normalise away, so "mat." and "mat" and "Mat!" agree.
 * The bank is English-only (the launch surface is English-only; the L1 lexicon
 * behind it is not), and a hygiene test asserts no bank word normalises empty.
 */
export function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z']/g, '');
}

export interface ReadWordMark {
  readonly word: string;
  readonly hit: boolean;
}

export interface ReadOutcome {
  /** The PASSAGE's words in order, each marked heard-or-not. Never the child's. */
  readonly words: readonly ReadWordMark[];
  readonly hits: number;
  readonly total: number;
  readonly pct: number;
  /** The scripted score line ("⭐ Perfect! Every word! ⭐"). */
  readonly line: string;
  /** The scripted celebrate-or-practice reply, in block grammar. */
  readonly reply: string;
  readonly trace: string;
}

/**
 * Score a read-aloud attempt against its passage. A pure function — same
 * transcript, same passage, same marks, forever.
 *
 * The algorithm is the prototype's `scoreReading` (chittu-v3.html:983)
 * unchanged: normalise both sides, then mark each passage word by set
 * membership in the heard words. Order-insensitive by design — browser ASR
 * reorders and merges freely, and punishing word order would score the
 * transcriber, not the child. A fancier aligner is a Phase 2 conversation to
 * have WITH the child-speech ASR work, not a thing to invent around a
 * placeholder transcriber.
 *
 * The reply copy is the prototype's, verbatim (:994, :997): celebration on a
 * clean read, guided practice naming up to three missed words otherwise. The
 * chips are navigation the client dispatches locally — they never become model
 * turns.
 */
export function readTurn(passage: ReadPassage, said: string, kid: string): ReadOutcome {
  const shown = passage.text.split(/\s+/);
  const target = shown.map(normWord);
  const heard = said.split(/\s+/).map(normWord);
  const marks = target.map((t) => heard.includes(t));
  const hits = marks.filter(Boolean).length;
  const total = target.length;
  const pct = Math.round((hits / total) * 100);

  const words: readonly ReadWordMark[] = shown.map((word, i) => ({
    word, hit: marks[i] === true,
  }));

  // The prototype branches on `pct === 100`; this branches on the count. They
  // differ only when rounding could carry 99.5% up to 100 — impossible at the
  // bank's sentence lengths, but "you read every single word" must never be
  // said over a rounded miss, so the branch tests the claim itself.
  if (hits === total) {
    return {
      words, hits, total, pct,
      line: '⭐ Perfect! Every word! ⭐',
      reply: `WOW, ${kid}! You read every single word! [BIG]🏆[/BIG] `
        + '[CHIPS]Next sentence!|Read it again|Back to chat[/CHIPS]',
      trace: 'READING COACH · celebrate',
    };
  }
  const missed = shown.filter((_, i) => !marks[i]).slice(0, 3).join(', ');
  return {
    words, hits, total, pct,
    line: `🌟 ${hits} of ${total} words — great reading!`,
    reply: `So close! Let's practice these words together: ${missed}. `
      + "Sound them out slowly — you've got this! "
      + '[CHIPS]Try again!|Next sentence|Back to chat[/CHIPS]',
    trace: 'READING COACH · guided practice',
  };
}
