import { describe, expect, it } from 'vitest';

import {
  BANDS,
  NO_SUBJECT_LINE,
  SUBJECT_ORDER,
  SUBJECT_PED,
  detectSubject,
  subjectPedagogyLine,
} from './index.js';
import type { Subject } from './index.js';

describe('detection order (REGRESSION-LOCKED)', () => {
  // CLAUDE.md: languages BEFORE science, because "how do you say…" must not
  // match science's `how (do|does|is|can)`. These three fail if reordered.
  it('routes "how do you say …" to languages, not science', () => {
    expect(detectSubject('how do you say hello in tamil')).toBe('languages');
  });

  it('routes "how do you say …" to languages even with no language named', () => {
    // 'tamil' removed, so ONLY the order decides: both patterns match "how do".
    expect(detectSubject('how do you say thank you')).toBe('languages');
    expect(SUBJECT_PED.science.k.test('how do you say thank you')).toBe(true);
  });

  it('declares languages before science', () => {
    expect(SUBJECT_ORDER.indexOf('languages'))
      .toBeLessThan(SUBJECT_ORDER.indexOf('science'));
  });

  it('walks SUBJECT_PED in its literal key order', () => {
    expect(Object.keys(SUBJECT_PED)).toEqual([...SUBJECT_ORDER]);
    expect([...SUBJECT_ORDER]).toEqual([
      'languages', 'science', 'english', 'history', 'geography', 'coding', 'art',
    ]);
  });

  it('would pick science if the walk order were science-first', () => {
    // Guards the guard: proves the cases above discriminate on order alone.
    const scienceFirst: Subject[] = [
      'science', ...SUBJECT_ORDER.filter((s) => s !== 'science'),
    ];
    const walk = (t: string) => scienceFirst.find((s) => SUBJECT_PED[s].k.test(t)) ?? null;
    expect(walk('how do you say hello in tamil')).toBe('science');
    expect(detectSubject('how do you say hello in tamil')).not.toBe(walk('how do you say hello in tamil'));
  });
});

describe('detectSubject', () => {
  it.each<[string, Subject]>([
    ['translate cat into french', 'languages'],
    ['why do plants need water', 'science'],
    ['how does a magnet work', 'science'],
    ['what is a sentence', 'english'],
    ['opposite word of big', 'english'],
    ['who was gandhi', 'history'],
    ['where is japan', 'geography'],
    ['the united states', 'geography'],
    ['python loop', 'coding'],
    ['draw a cat', 'art'],
    ['origami', 'art'],
  ])('%s -> %s', (text, subject) => {
    expect(detectSubject(text)).toBe(subject);
  });

  it('matches case-insensitively (the /i flag)', () => {
    expect(detectSubject('WHY IS THE SKY BLUE')).toBe('science');
    expect(detectSubject('Draw A Cat')).toBe('art');
  });

  it('returns null when nothing matches', () => {
    expect(detectSubject('hello')).toBeNull();
    expect(detectSubject('tell me a story about a dragon')).toBeNull();
    expect(detectSubject('what is 2 plus 2')).toBeNull();
    expect(detectSubject('i love my dog')).toBeNull();
    expect(detectSubject('')).toBeNull();
  });

  it('is stateless across calls', () => {
    // Would break if any pattern ever gained /g or /y and carried lastIndex.
    expect(detectSubject('why')).toBe('science');
    expect(detectSubject('why')).toBe('science');
  });
});

describe('prototype substring quirks (ported, NOT fixed)', () => {
  // Every pattern is unanchored, so words containing a keyword match. These
  // assertions exist so the behaviour cannot change silently.
  it('"smart" matches art', () => {
    expect(detectSubject('that was a smart idea')).toBe('art');
  });

  it('"nobody" matches science via `body`', () => {
    expect(detectSubject('nobody likes me')).toBe('science');
  });

  it('"chair" matches science via `air`', () => {
    expect(detectSubject('my chair is broken')).toBe('science');
  });
});

describe('SUBJECT_PED patterns are byte-faithful to the prototype', () => {
  it.each<[Subject, string]>([
    ['languages', 'spanish|french|hindi|tamil|german|japanese|korean|how (do you|to) say|what does .* mean in|translate|in french|in spanish|in hindi|in tamil'],
    ['science', 'why|how (do|does|is|can)|what happens|plant|animal|body|space|planet|water|air|light|sound|energy|magnet|volcano|weather|rain|sun|moon|star|insect|bird|dinosaur|electricity|gravity|heart|brain|photosynth|experiment'],
    ['english', 'noun|verb|adjective|adverb|grammar|sentence|spelling|plural|tense|punctuation|comma|paragraph|essay|letter writing|synonym|antonym|opposite word'],
    ['history', 'history|ancient|king|queen|emperor|empire|war|independence|freedom|gandhi|nehru|chola|ashoka|mughal|british|before people|long ago|olden days|civilization|pyramid'],
    ['geography', 'country|countries|capital|river|mountain|ocean|continent|map|desert|forest|city|state|monsoon|climate|earthquake|where is'],
    ['coding', 'code|coding|program|python|scratch|loop|variable|function|algorithm|bug|computer think'],
    ['art', 'draw|drawing|paint|colour|color|sketch|craft|origami|art'],
  ])('%s source is unchanged', (subject, source) => {
    expect(SUBJECT_PED[subject].k.source).toBe(source);
  });

  it('every pattern carries /i and nothing else', () => {
    for (const s of SUBJECT_ORDER) expect(SUBJECT_PED[s].k.flags).toBe('i');
  });
});

describe('subjectPedagogyLine', () => {
  it('returns the subject method line', () => {
    expect(subjectPedagogyLine('science')).toBe(SUBJECT_PED.science.line);
    expect(subjectPedagogyLine('science')).toMatch(/^SCIENCE method \(Phenomenon-first/);
  });

  it('falls back to the universal method when nothing was detected', () => {
    expect(subjectPedagogyLine(null)).toBe(NO_SUBJECT_LINE);
    expect(NO_SUBJECT_LINE)
      .toBe('No specific subject detected — use the universal method (rule 14).');
  });

  it('opens each line with its own method name', () => {
    const openings: Record<Subject, string> = {
      languages: 'NEW-LANGUAGE method', science: 'SCIENCE method',
      english: 'LANGUAGE method', history: 'HISTORY method',
      geography: 'GEOGRAPHY method', coding: 'CODING method', art: 'ART method',
    };
    for (const s of SUBJECT_ORDER) {
      expect(SUBJECT_PED[s].line.startsWith(openings[s])).toBe(true);
    }
  });
});

describe('BANDS', () => {
  it('has exactly the three bands', () => {
    expect(Object.keys(BANDS)).toEqual(['explorer', 'builder', 'thinker']);
  });

  it.each<['explorer' | 'builder' | 'thinker', string, number]>([
    ['explorer', '🌱 Explorer (4–7)', 30],
    ['builder', '🔧 Builder (8–12)', 55],
    ['thinker', '🔭 Thinker (13–17)', 75],
  ])('%s label and word cap', (band, label, words) => {
    expect(BANDS[band].label).toBe(label);
    expect(BANDS[band].words).toBe(words);
  });

  it('carries the exact system-prompt fragments', () => {
    expect(BANDS.explorer.sys).toBe('The child is 4-7. Explain like they are 5: ONE big simple idea, in 2-3 tiny sentences (max 8 words each), using things a small child knows (toys, animals, food, family). Happy words, 2-3 emojis. If a real answer would take longer, give the simplest true first bite and offer to say more.');
    expect(BANDS.builder.sys).toBe('The child is 8-12. Explain like a brilliant older cousin: 2-3 short sentences, one clear idea + one everyday example, playful, 2 emojis. Never a paragraph. Offer a next question via chips.');
    expect(BANDS.thinker.sys).toBe('The user is a teenager. Explain clearly and honestly in up to 4 short sentences: idea, why it works, one real example. Snappy and respectful, never babyish, 1-2 emojis. Never a paragraph.');
  });

  it('says "teenager", not "child", for thinker', () => {
    // Prototype wording — the 13-17 band is addressed as the user, not a child.
    expect(BANDS.thinker.sys.startsWith('The user is a teenager.')).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(BANDS)).toBe(true);
    expect(Object.isFrozen(SUBJECT_PED)).toBe(true);
  });
});
