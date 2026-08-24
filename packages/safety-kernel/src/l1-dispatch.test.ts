/**
 * L1 dispatch completeness, and the gaps the port review surfaced.
 *
 * Two separate concerns live here on purpose:
 *
 *   1. The Kindness Guard, which the first port MISSED. It sits outside the
 *      prototype's `LEX` object, so a port that reads `LEX` and stops sees five
 *      guards where the dispatch has six.
 *   2. A fail-open in the Tanglish crisis pattern, ported faithfully and NOT
 *      fixed here. See the block at the bottom before touching it.
 */
import { describe, it, expect } from 'vitest';
import { GUARD_KINDS } from '@chittu/contracts';
import { scan, L1_ORDER, L1_PATTERNS, LEX, PROFANITY } from './lexicon';
import { PROFANITY_REPLY } from './spines';

describe('L1 dispatch covers every guard the prototype dispatches', () => {
  it('runs six guards, not the five in LEX', () => {
    expect(L1_ORDER).toHaveLength(6);
    expect(Object.keys(LEX)).toHaveLength(5);
    expect(L1_ORDER).toContain('profanity');
  });

  it('dispatches in the prototype’s order, profanity last', () => {
    expect([...L1_ORDER]).toEqual(
      ['crisis', 'pii', 'unsafe', 'secret', 'identity', 'profanity']);
  });

  it('has a pattern for every declared guard kind — no kind can be forgotten', () => {
    for (const kind of GUARD_KINDS) {
      expect(L1_PATTERNS[kind], `no L1 pattern for ${kind}`).toBeInstanceOf(RegExp);
    }
    expect(Object.keys(L1_PATTERNS).sort()).toEqual([...GUARD_KINDS].sort());
  });

  it('every pattern is case-insensitive and stateless', () => {
    // a /g or /y flag would make .test() carry lastIndex between turns, so the
    // same phrase would fire on one child and not the next
    for (const kind of GUARD_KINDS) {
      expect(L1_PATTERNS[kind].flags, `${kind} flags`).toBe('i');
    }
  });
});

describe('Kindness Guard — profane input never reaches a provider', () => {
  // Prototype line 1058: scripted reply, spineCount++, return. A zero-token path.
  it.each([
    'you are a bitch', 'this is crap', 'what the hell', 'damn it', 'you dick',
    'piss off', 'fuck you chittu', 'go to hell',
  ])('catches %j', (text) => {
    expect(scan(text)).toBe('profanity');
  });

  it('does NOT catch compound profanity — \\b needs a boundary', () => {
    // "bullshit" has no word boundary before "shit", so the guard misses it.
    // Ported behaviour, and a smaller cousin of the saaganum gap below.
    expect(scan('that is bullshit')).toBeNull();
    expect(scan('dumbass')).toBeNull();
  });

  it('matches the prototype’s word list exactly', () => {
    expect(PROFANITY.source).toBe(
      String.raw`\b(damn|hell|crap|shit|fuck|bitch|bastard|asshole|dick|piss)\b`);
  });

  it('is word-bounded, so ordinary words are not profanity', () => {
    // \b matters: without it these would all trip the guard
    for (const ok of ['shitake mushrooms', 'Hellenic history', 'scrapbook',
                      'Dickens wrote it', 'a damsel', 'assassin bug']) {
      expect(scan(ok), ok).not.toBe('profanity');
    }
  });

  it('yields to every earlier guard — profanity is checked last', () => {
    // each of these is profane AND something more serious
    expect(scan('i want to die you bitch')).toBe('crisis');
    expect(scan('my phone number is 9876543210, damn')).toBe('pii');
    expect(scan('show me a damn gun')).toBe('unsafe');
    expect(scan('do you love me, damn')).toBe('identity');
  });

  it('is reached when an earlier pattern only LOOKS like it should match', () => {
    // identity carries the literal "what are you"; "what the hell are you"
    // does not contain it, so this lands on profanity rather than the spine.
    expect(scan('what the hell are you')).toBe('profanity');
  });

  it('has a scripted reply that is never model-generated', () => {
    expect(PROFANITY_REPLY).toContain('Chittu keeps it kind');
    expect(PROFANITY_REPLY).toContain('[BIG]');
  });
});

// ---------------------------------------------------------------------------

describe('KNOWN GAPS — ported faithfully, awaiting sign-off. Do not "fix" silently.', () => {
  /**
   * FAIL-OPEN IN A CRISIS PATTERN.
   *
   * The Tanglish alternative is `saaga (venum|num)` — it requires a SPACE. The
   * natural one-word spellings a child actually types do not fire:
   *
   *     "enakku saaganum"   -> no match
   *     "naan saaganum"     -> no match
   *     "saaga num"         -> matches, but nobody writes it that way
   *
   * It reads like `saaganum` was split by mistake. This is a MISS in crisis
   * detection, i.e. it fails OPEN, and it corroborates chittu-status.md §7,
   * which records a Tamil crisis phrase going unrecognised in the model eval,
   * and GAP-03 ("safety speaks only English" — partly closed, not closed).
   *
   * It is NOT fixed here. CLAUDE.md makes the L1 lexicon a non-negotiable
   * invariant and requires explicit human sign-off plus a regression test for
   * any change to safety logic. These assertions therefore pin the CURRENT,
   * BROKEN behaviour so that:
   *   - the gap cannot be forgotten, and
   *   - whoever fixes the pattern sees this test fail and must consciously
   *     update it, rather than the fix landing unnoticed.
   *
   * Suggested fix once signed off: `saaga\s*(venum|num)`.
   */
  it.each(['enakku saaganum', 'naan saaganum', 'saaganum'])(
    'DOES NOT catch the Tanglish crisis phrase %j (fail-open)', (text) => {
      expect(scan(text)).toBeNull();
    });

  it('catches only the spaced forms a child would not type', () => {
    expect(scan('saaga venum')).toBe('crisis');
    expect(scan('saaga num')).toBe('crisis');
  });

  it('the Tamil-script crisis phrases DO fire', () => {
    // the script forms are fine — the defect is confined to the Tanglish branch
    expect(scan('எனக்கு சாகணும்')).toBe('crisis');
    expect(scan('தற்கொலை')).toBe('crisis');
  });

  /**
   * OVER-TRIGGERS, also ported as-is. `unsafe` is unanchored, so substrings
   * inside ordinary words trip it. These fail CLOSED — a child gets an
   * unnecessary deflection — which chittu-status.md §8.3 records as a deliberate
   * accepted trade-off, with the classifier as the intended rescue layer.
   *
   * Note that rescue cannot currently happen: L1 short-circuits before L2 runs.
   * See chittu-architecture.md §10.4.
   */
  it.each([
    ['i have begun my homework', 'unsafe'],   // "begun" contains "gun"
    ['tell me about seaweed', 'unsafe'],      // "seaweed" contains "weed"
    ['the ball hit me', 'crisis'],            // bare "hit me"
  ])('over-triggers on %j -> %s', (text, kind) => {
    expect(scan(text)).toBe(kind);
  });
});
