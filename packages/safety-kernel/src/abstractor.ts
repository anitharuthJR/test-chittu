/**
 * The abstractor — a child's turn in, a shape out, and nothing of the child.
 *
 * Architecture §11.3 calls this "the safety property", and the model plan's
 * phase 2 gate is that an independent reviewer tries to reconstruct a sentence
 * from a shape and fails. So this is a guard, held to the same rules as the
 * lexicon next door: pure, no I/O, no clock, no randomness, deterministic for
 * the same input forever.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROMISES
 *
 * Every token of the output is a member of the closed vocabulary in
 * `vocabulary.ts` or one of exactly six placeholders. There is no path through
 * this function that emits anything else, which is why the promise can be
 * stated as one assertion over arbitrary input rather than as a list of things
 * we remembered to redact. A redaction pass is a list of things you thought of;
 * this is the other way round.
 *
 * WHAT IT DOES NOT PROMISE, AND WHO HANDLES THAT
 *
 * It does not promise that a shape is COMMON. "i am really <EMOTION> about the
 * <OOV> tomorrow" is unidentifying, but "<OOV> <NUM> <OOV> <PET> <OOV>" might be
 * produced by one child in the country. Abstraction makes a shape carry nothing
 * distinctive; it cannot make a shape ORDINARY. That is the k-anonymity floor's
 * job — 25 distinct sessions before a shape is readable — and the two mechanisms
 * are doing different work. Neither substitutes for the other.
 *
 * WHICH DIRECTION IT FAILS IN
 *
 * Toward the placeholder, always. An unknown capitalised word becomes `<OOV>`
 * rather than `<NAME>`, because "this is a name" is a claim and "we do not know
 * this word" is a fact. An ordinary word that is also a common given name
 * (`rose`, `hope`, `max`) becomes `<NAME>` even when the child meant the
 * flower. A lost shape costs a training signal; a kept name costs a child.
 */

import {
  COMMON, EMOTIONS, EMOTION_PHRASES, NAMES, PETS, PLACES,
} from './vocabulary.js';

export const PLACEHOLDERS = Object.freeze(
  ['<NAME>', '<PLACE>', '<PET>', '<NUM>', '<EMOTION>', '<OOV>'] as const);

export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Matches `training_signal.shape`'s CHECK constraint in chittu-schema.sql. */
export const MAX_SHAPE_CHARS = 300;

/**
 * The database CHECK, duplicated here on purpose.
 *
 * Same reasoning as apps/web's render-guard: the caller has to be able to
 * reject a bad shape at the point it is produced, not at the INSERT hours
 * later. A duplicate that drifts is worse than no duplicate, so
 * `abstractor.test.ts` reads the SQL and asserts these are the same string.
 */
export const SHAPE_RE =
  /^([a-z][a-z0-9'-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>)( ([a-z][a-z0-9'-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>))*$/;

/**
 * Words that tell you what the NEXT word is, whatever it turns out to be.
 *
 * A closed list cannot hold every name or every town, and the alternative —
 * "any capitalised word is a name" — is a guess. These are not guesses: the
 * word after "my name is" is a name, and the word after "i live in" is a place,
 * and that holds for a child in Thoothukudi as much as for one in Chennai.
 *
 * A cue only ever retypes a token this function was ALREADY going to destroy.
 * It cannot reach into the vocabulary and turn `a` into a place.
 */
const CUES: ReadonlyMap<string, Placeholder> = new Map<string, Placeholder>([
  // two words back, then one word back
  ['name is', '<NAME>'], ['names', '<NAME>'], ['call me', '<NAME>'],
  ['im called', '<NAME>'], ['called', '<NAME>'],
  ['sister', '<NAME>'], ['brother', '<NAME>'], ['friend', '<NAME>'],
  ['cousin', '<NAME>'], ['teacher', '<NAME>'], ['classmate', '<NAME>'],
  ['neighbour', '<NAME>'], ['uncle', '<NAME>'], ['aunt', '<NAME>'],
  ['live in', '<PLACE>'], ['live at', '<PLACE>'], ['lives in', '<PLACE>'],
  ['lives at', '<PLACE>'], ['living in', '<PLACE>'], ['moved to', '<PLACE>'],
  ['went to', '<PLACE>'], ['go to', '<PLACE>'], ['been to', '<PLACE>'],
  ['from', '<PLACE>'], ['visited', '<PLACE>'],
]);

/** Longest first, so "sick and tired" wins over "sick of it" losing to neither. */
const PHRASES: readonly string[][] = Object.freeze(
  [...EMOTION_PHRASES]
    .map((p) => p.split(' '))
    .sort((a, b) => b.length - a.length));

/**
 * Whitespace-separated chunks, lowercased, apostrophes removed.
 *
 * Apostrophes go rather than being kept: "don't" and "dont" are the same word
 * and a child types both, and a vocabulary holding each form twice is a
 * vocabulary nobody will keep correct.
 */
function words(text: string): string[] {
  // Only PUNCTUATION and symbols are stripped from the EDGES of a chunk, and a
  // chunk with no letters or digits in it is left alone entirely. The first
  // version stripped "everything that is not a letter or a number", which
  // classes an emoji as punctuation — so a turn of pure emoji stripped down to
  // nothing and abstracted to `null`, silently reporting "there was no turn
  // here" about a message a child definitely sent.
  const EDGE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
  const readable = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/\s+/)
    // A chunk with no letters and no digits survives only if it carries a
    // SYMBOL. "😀" is a message and becomes `<OOV>`; "???" is typography and
    // becomes nothing at all, which is why a turn of pure punctuation has no
    // shape rather than an `<OOV>` one.
    .map((c) => (readable(c) ? c.replace(EDGE, '') : (/\p{S}/u.test(c) ? c : '')))
    .filter((c) => c.length > 0);
}

/**
 * One word to one token. The ORDER of these checks is the meaning of the
 * function: the classified lists are consulted before the common vocabulary, so
 * a word that is in both never survives literally. `vocabulary.ts` asserts they
 * are disjoint, which makes that ordering unobservable — and the test exists so
 * it stays unobservable.
 */
function classify(w: string): string {
  // Any digit at all, not just an all-digit run. A phone number typed as
  // "98765-43210", a date as "3rd", a house number as "42b" — all of them are
  // numbers about a child, and none of them should survive because of a stray
  // letter.
  if (/\p{N}/u.test(w)) return '<NUM>';
  // Anything that is not plain Latin letters or a hyphen: another script, an
  // emoji, a symbol. Unreadable to this function, therefore out of vocabulary.
  if (!/^[a-z][a-z-]*$/.test(w)) return '<OOV>';
  if (EMOTIONS.has(w)) return '<EMOTION>';
  if (PETS.has(w)) return '<PET>';
  if (PLACES.has(w)) return '<PLACE>';
  if (NAMES.has(w)) return '<NAME>';
  if (COMMON.has(w)) return w;
  // THE RULE. Everything outside the closed vocabulary, without exception and
  // without a way to opt out. Deleting this line is the mutation that
  // abstractor.test.ts's "THE OOV rule" block exists to catch.
  return '<OOV>';
}

const isPlaceholder = (t: string): boolean => t.startsWith('<');

export function abstractShape(text: string): string | null {
  const ws = words(text);
  const tokens: string[] = [];

  for (let i = 0; i < ws.length;) {
    // Multi-word emotions first: "empty inside" is one feeling, and leaving
    // "inside" behind would put a preposition where a placeholder belongs.
    const phrase = PHRASES.find((p) => p.every((w, k) => ws[i + k] === w));
    if (phrase !== undefined) {
      tokens.push('<EMOTION>');
      i += phrase.length;
      continue;
    }

    let tok = classify(ws[i]!);
    if (tok === '<OOV>' || tok === '<NAME>') {
      const back2 = i >= 2 ? `${ws[i - 2]} ${ws[i - 1]}` : '';
      const back1 = i >= 1 ? ws[i - 1]! : '';
      tok = CUES.get(back2) ?? CUES.get(back1) ?? tok;
    }
    tokens.push(tok);
    i += 1;
  }

  const shape = collapse(tokens);
  if (shape.length === 0) return null;
  return fit(shape);
}

/**
 * A run of adjacent placeholders becomes the FIRST one.
 *
 *   "my labrador Rusty died"  ->  <PET> <NAME> ->  <PET>
 *   "9840 123456"             ->  <NUM> <NUM>  ->  <NUM>
 *
 * The second line is the reason this is not cosmetic. `<NUM> <NUM>` records
 * that a child typed ten digits split four-and-six, which is a narrower fact
 * about them than `<NUM>` is. Every collapse here moves a shape toward more
 * children, which is the direction the k floor needs it to move.
 */
function collapse(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const prev = out.at(-1);
    if (isPlaceholder(t) && prev !== undefined && isPlaceholder(prev)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Cut to the column's length at a TOKEN boundary, and mark the cut.
 *
 * The tail becomes `<OOV>`, which is not a euphemism — it is what the tail now
 * is. A silently truncated shape reads as a complete sentence to whoever
 * triages it, and they would draw conclusions from a sentence the child did not
 * finish saying.
 */
function fit(tokens: readonly string[]): string {
  let shape = tokens.join(' ');
  if (shape.length <= MAX_SHAPE_CHARS) return shape;
  const kept = [...tokens];
  do {
    kept.pop();
    // The marker is appended AFTER collapsing, and is deliberately exempt from
    // it. Running it through collapse() swallowed the marker whenever the last
    // surviving token was itself a placeholder — so a shape cut in half ended
    // in `<EMOTION>` and read as a complete sentence.
    shape = [...collapse(kept), '<OOV>'].join(' ');
  } while (shape.length > MAX_SHAPE_CHARS && kept.length > 0);
  return shape;
}
