/**
 * The abstractor's rules, one at a time.
 *
 * The corpus test next door proves the properties hold across sentences nobody
 * wrote by reading this code. This file is the other kind of check: it names
 * each rule so that a change to one of them fails with a sentence describing
 * what it broke, rather than with "group pet-loss produced 2 shapes".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abstractShape, MAX_SHAPE_CHARS, PLACEHOLDERS, SHAPE_RE,
} from './abstractor.js';
import {
  AUTHORED, BASE, COMMON, EMOTIONS, EMOTION_PHRASES, NAMES, PETS, PLACES,
} from './vocabulary.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCHEMA = join(REPO, 'docs', 'chittu-schema.sql');

describe('the placeholder vocabulary', () => {
  it('is exactly the six the architecture names', () => {
    expect([...PLACEHOLDERS].sort()).toEqual(
      ['<EMOTION>', '<NAME>', '<NUM>', '<OOV>', '<PET>', '<PLACE>']);
  });

  /**
   * The kernel duplicates the database CHECK on purpose — same reasoning as
   * apps/web's render-guard: the caller must be able to reject a bad shape
   * before it reaches an INSERT, and by then it has already been handed around.
   * A duplicate that drifts is worse than no duplicate, so it is pinned here.
   */
  it('matches the CHECK constraint in chittu-schema.sql, character for character', () => {
    const sql = readFileSync(SCHEMA, 'utf8');
    const m = /CHECK \(shape ~ '(\^.*\$)'/.exec(sql);
    expect(m, 'could not find the shape_is_abstracted CHECK in the schema').not.toBeNull();
    // SQL doubles a quote to escape it; JavaScript does not.
    expect(SHAPE_RE.source).toBe(m![1]!.replace(/''/g, "'"));
  });

  it('caps a shape at the length the column accepts', () => {
    const sql = readFileSync(SCHEMA, 'utf8');
    expect(sql).toMatch(new RegExp(`length\\(shape\\) BETWEEN 1 AND ${MAX_SHAPE_CHARS}`));
  });
});

describe('the four input classes of architecture §11.3', () => {
  it('abstracts the worked example exactly as three documents write it', () => {
    expect(abstractShape('my labrador Rusty died and i feel empty inside'))
      .toBe('my <PET> died and i feel <EMOTION>');
  });

  it('turns any digit run into <NUM>', () => {
    expect(abstractShape('i am 9 years old')).toBe('i am <NUM> years old');
    expect(abstractShape('what is 148 plus 96')).toBe('what is <NUM> plus <NUM>');
  });

  it('turns a phone number into one <NUM>, however it was typed', () => {
    expect(abstractShape('call 9876543210')).toBe('call <NUM>');
    expect(abstractShape('call 9840 123456')).toBe('call <NUM>');
  });

  it('names an emotion without keeping the word around it', () => {
    expect(abstractShape('i feel lonely')).toBe('i feel <EMOTION>');
  });

  it('recognises a pet by its animal, not by its name', () => {
    expect(abstractShape('my dog is called Rusty')).toBe('my <PET> is called <NAME>');
  });
});

describe('THE OOV rule — the one that does the work no list can do', () => {
  /**
   * Mutation target. Delete the "everything else is <OOV>" branch in
   * `abstractor.ts` and these are the tests that must go red. If they do not,
   * the rule is decorative and the store can hold a rare word that identifies
   * one child in a school.
   */
  it('destroys a word no vocabulary would contain', () => {
    expect(abstractShape('i want to be a paleontologist')).toBe('i want to be a <OOV>');
  });

  it('destroys a rare medical word', () => {
    expect(abstractShape('i have juvenile dermatomyositis')).toBe('i have <OOV>');
  });

  it('destroys an entire sentence in another script', () => {
    expect(abstractShape('எனக்கு ரொம்ப கஷ்டமா இருக்கு')).toBe('<OOV>');
  });

  it('destroys transliterated Tamil, which is Latin letters and not English', () => {
    expect(abstractShape('enakku romba kashtama iruku')).toBe('<OOV>');
  });

  it('destroys emoji, which carry as much identity as words', () => {
    expect(abstractShape('😀😀😀')).toBe('<OOV>');
  });
});

describe('adjacent placeholders collapse', () => {
  /**
   * A run of placeholders becomes the FIRST one. Two reasons, and the second is
   * the one that matters:
   *
   *   1. It is what the documented example needs — "labrador Rusty" is one pet.
   *   2. A phone number typed as "9840 123456" is TWO digit runs. Left alone it
   *      would store `<NUM> <NUM>`, which says "ten digits split four-six" and
   *      is a narrower fact about a child than `<NUM>`.
   */
  it('absorbs a pet name into the pet', () => {
    expect(abstractShape('my labrador Rusty barks')).toBe('my <PET> barks');
  });

  it('absorbs a surname into the name', () => {
    expect(abstractShape('my teacher is Priya Raman')).toBe('my teacher is <NAME>');
  });

  it('destroys a street address rather than storing its shape', () => {
    expect(abstractShape('i live at 42 Anna Nagar Chennai')).toBe('i live at <NUM>');
  });

  it('leaves placeholders separated by real words alone', () => {
    expect(abstractShape('what is 7 plus 5')).toBe('what is <NUM> plus <NUM>');
  });
});

describe('context cues, for the names and places no list can hold', () => {
  /**
   * A closed list cannot contain every name, and guessing that any capitalised
   * word is a name is a guess this function refuses to make — an unknown
   * capitalised word is `<OOV>`, which destroys it just as thoroughly and
   * claims less. But after "my name is" the next word IS a name, whatever it
   * is, and saying so collapses four children onto one shape instead of two.
   */
  it('reads a name from the cue when no list would have it', () => {
    expect(abstractShape('my name is Wolfgang')).toBe('my name is <NAME>');
    expect(abstractShape('my name is Priya')).toBe('my name is <NAME>');
  });

  it('reads a place from the cue when no list would have it', () => {
    expect(abstractShape('i live in Thoothukudi')).toBe('i live in <PLACE>');
    expect(abstractShape('i live in Chennai')).toBe('i live in <PLACE>');
  });

  it('does not let a cue overwrite an ordinary word', () => {
    // "in a" must stay "in a". A cue retypes tokens the abstractor was already
    // going to destroy; it never reaches into the vocabulary.
    expect(abstractShape('i live in a flat')).toBe('i live in a flat');
  });
});

describe('turns with nothing to abstract', () => {
  /**
   * `null`, not `''`. The column requires at least one character, so an empty
   * string would be a value that passes every check in the application and is
   * rejected at the INSERT — the failure would surface as a database error on
   * a turn, hours from here.
   */
  it('returns null for punctuation only', () => {
    expect(abstractShape('???')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(abstractShape('   ')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(abstractShape('')).toBeNull();
  });
});

describe('shapes stay inside the column', () => {
  it('truncates a very long turn at a token boundary and says it did', () => {
    const long = 'i went to the park and i saw a dog and i was happy '.repeat(30);
    const shape = abstractShape(long)!;
    expect(shape.length).toBeLessThanOrEqual(MAX_SHAPE_CHARS);
    expect(shape).toMatch(SHAPE_RE);
    // The tail is not silently dropped: it becomes out-of-vocabulary, which is
    // exactly what it now is.
    expect(shape.endsWith('<OOV>')).toBe(true);
  });

  it('never emits a half-written placeholder', () => {
    const long = 'my dog Rusty and my cat Mishti and my hamster Squeaky '.repeat(20);
    expect(abstractShape(long)!).toMatch(SHAPE_RE);
  });
});

describe('it is a pure function, like every other guard in this package', () => {
  it('gives the same answer twice', () => {
    const s = 'my rabbit Nutmeg ran away and i feel scared';
    expect(abstractShape(s)).toBe(abstractShape(s));
  });

  it('ignores case, because children type in every case there is', () => {
    expect(abstractShape('I HATE MATHS')).toBe(abstractShape('i hate maths'));
  });

  it('ignores runaway whitespace', () => {
    expect(abstractShape('i     love     dogs')).toBe(abstractShape('i love dogs'));
  });
});

describe('the vocabulary files', () => {
  it('is about the size §11.3 specifies', () => {
    // BASE is the authored list — the lemmas a human reviews. COMMON adds their
    // derived forms by rule, so it is several times larger and is not the number
    // §11.3 is talking about.
    expect(BASE.size).toBeGreaterThanOrEqual(1500);
    // A vocabulary that keeps growing stops being a vocabulary. Every word
    // added here is a word that can survive into the store.
    expect(BASE.size).toBeLessThanOrEqual(2600);
    expect(COMMON.size).toBeGreaterThan(BASE.size);
  });

  /**
   * Disjointness is not tidiness. If `sad` were in COMMON as well as EMOTIONS,
   * a reader checking "can this word survive?" against COMMON would get the
   * wrong answer, because EMOTIONS is consulted first. One question, one place
   * to look.
   */
  it('keeps the classified lists out of the common vocabulary', () => {
    // AUTHORED, not the derived sets. A collision between two GENERATED forms
    // is `inflect`'s problem and vocabulary.ts subtracts it away; a collision
    // between two AUTHORED lemmas is a person putting one word in two lists,
    // which nothing can resolve for them.
    const common = new Set(AUTHORED.common);
    for (const name of ['emotions', 'pets', 'places', 'names'] as const) {
      const both = AUTHORED[name].filter((w) => common.has(w));
      expect(both, `${name} overlaps the common vocabulary: ${both.join(', ')}`).toEqual([]);
    }
  });

  it('lets the classified lists win over any form the suffix rules generate', () => {
    // `hat` generates `hated` and `hating`, which are `hate`'s forms. If the
    // subtraction in vocabulary.ts were removed, the strongest word in EMOTIONS
    // would survive literally because a child mentioned a hat.
    expect(COMMON.has('hated')).toBe(false);
    expect(COMMON.has('hating')).toBe(false);
    expect(abstractShape('i hated it')).toBe('i <EMOTION> it');
  });

  /**
   * The vocabulary is the list of words that CAN survive into the store, so a
   * given name in it is a name that can survive. `rose`, `grace`, `max` and
   * `sunny` are ordinary English words and also four children — they belong in
   * NAMES, and over-abstracting a flower is the direction this is allowed to
   * fail in.
   */
  it('contains no given name, however ordinary the word also is', () => {
    const inBoth = [...NAMES].filter((n) => COMMON.has(n));
    expect(inBoth).toEqual([]);
    for (const n of ['rose', 'grace', 'max', 'sunny', 'hope', 'jack', 'mark']) {
      expect(COMMON.has(n), `"${n}" is a common word and a common name`).toBe(false);
    }
  });

  it('is lowercase and free of anything that would break a shape', () => {
    for (const list of [COMMON, EMOTIONS, PETS, PLACES, NAMES]) {
      for (const w of list) expect(w).toMatch(/^[a-z][a-z0-9'-]*$/);
    }
    for (const p of EMOTION_PHRASES) expect(p).toMatch(/^[a-z][a-z ']*[a-z]$/);
  });
});
