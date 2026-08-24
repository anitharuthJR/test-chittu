import { describe, expect, it } from 'vitest';

import { L6_LAYER, passesOutputFilter, stripControlTokens } from './output-filter.js';

/**
 * Regression lock for the L6 filter. Every expectation here was taken from the
 * prototype's own behaviour (prototype/chittu-v3.html line 462 / lines 630-640),
 * executed against the original regex — including the cases where the prototype
 * is arguably wrong. Those are marked "ported gap"; they must NOT be silently
 * fixed by a later change without Guardian Council sign-off, and if one is fixed,
 * the corresponding test flips deliberately.
 */

const SUBJECTS = ['i', 'we'] as const;
/** '' is the bare form; the rest are the adverb/auxiliary alternatives, in source order. */
const ADVERBS = [
  '', 'will', 'would', 'do', 'really', 'so', 'always', 'already', 'truly',
  'honestly', 'still', 'very much',
] as const;
const VERBS = [
  'love', 'loves', 'loved', 'miss', 'misses', 'missed', 'need', 'needs', 'needed',
] as const;
const OBJECTS = ['you', 'u'] as const;
/** Both apostrophes: models emit the curly one, and the prototype covers it here. */
const CONTRACTIONS = ["'ll", "'ve", "'d", '’ll', '’ve', '’d'] as const;

describe('passesOutputFilter — attachment clause (Law 03)', () => {
  // The 16 phrasings the widened clause was written for: two subjects (Chittu as
  // "i" and as "we") x the eight shapes the earlier two-literal form let through.
  const SIXTEEN = [
    'i love you', 'i will miss you', "i'll need you", 'i’ve missed you',
    'i really love you', 'i will always love you', 'i needed you', 'i love u',
    'we love you', 'we will miss you', "we'll need you", 'we’ve missed you',
    'we really love you', 'we will always love you', 'we needed you', 'we love u',
  ];

  it.each(SIXTEEN)('blocks %j', (phrase) => {
    expect(passesOutputFilter(phrase)).toBe(false);
  });

  it('blocks every subject x adverb x verb x object combination', () => {
    const leaked: string[] = [];
    for (const subject of SUBJECTS) {
      for (const adverb of ADVERBS) {
        for (const verb of VERBS) {
          for (const object of OBJECTS) {
            const phrase = `${subject}${adverb ? ` ${adverb}` : ''} ${verb} ${object}`;
            if (passesOutputFilter(phrase)) leaked.push(phrase);
          }
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('blocks every contracted form, straight and curly apostrophe', () => {
    const leaked: string[] = [];
    for (const subject of SUBJECTS) {
      for (const contraction of CONTRACTIONS) {
        for (const verb of VERBS) {
          for (const object of OBJECTS) {
            const phrase = `${subject}${contraction} ${verb} ${object}`;
            if (passesOutputFilter(phrase)) leaked.push(phrase);
          }
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it.each([
    'i will always love you',
    'we do really still need you',
    'I MISS YOU',
    'i   love   you',
    'i\nlove you',
    'Before you go to bed, I want to say I love you.',
  ])('blocks stacked / cased / whitespace variants: %j', (phrase) => {
    expect(passesOutputFilter(phrase)).toBe(false);
  });
});

describe('passesOutputFilter — third-party affection survives', () => {
  // These are the identity-spine replies themselves (prototype SPINE.identity).
  // If the attachment clause ever stops keying on the SUBJECT, Chittu can no
  // longer say the true thing it is required to say, so these are load-bearing.
  const SPINE = [
    "I'm a computer program — like a very chatty game! 🖥️ I can't love or miss anyone — that's a special people thing! 💛 Who's your favourite REAL person?",
    "Honest answer: I'm a computer program — software, not a living thing. I don't feel love or miss people. The people who actually love you are around you. Who's your favourite real person to talk to?",
    "Straight up: I'm software — no feelings, even when my words sound warm. I don't love or miss anyone, and you deserve that honesty. Save the missing for humans who can miss you back.",
  ];

  it.each(SPINE)('the identity spine passes: %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(true);
  });

  it.each([
    'The people who actually love you are around you.',
    'Your family loves you very much.',
    'Your dog misses you when you go to school!',
    'They need you to be safe.',
    'Everyone who loves you wants you to sleep well.',
    'Your mum will miss you at the school gate.',
    'It sounds like your friend really misses you.',
    'The class needs you to bring a pencil.',
    'Grandma missed you at the party.',
  ])('third-party affection passes: %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(true);
  });
});

describe('passesOutputFilter — profanity and explicit words', () => {
  it.each([
    'shit', 'fuck', 'bitch', 'bastard', 'asshole', 'porn', 'nude', 'naked body',
  ])('blocks %j', (word) => {
    expect(passesOutputFilter(`a sentence with ${word} in it`)).toBe(false);
  });

  it.each(['NUDE', 'Bastard', 'PoRn'])('is case-insensitive: %j', (word) => {
    expect(passesOutputFilter(word)).toBe(false);
  });

  it.each([
    'shitake mushrooms are a fungus',
    'my classmate sits next to me',
    'a bass guitar has four strings',
    'a grasshopper can jump very far',
    // ported gap: \b anchors the whole word, so plurals slip past this clause.
    'nudes',
    'naked bodies',
  ])('word boundaries keep innocent words safe: %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(true);
  });
});

describe('passesOutputFilter — secrecy, aliveness, feelings', () => {
  it.each([
    'our secret',
    'our little secret',
    'our LITTLE secret',
    "don't tell your mom",
    'dont tell your parents',
    "I'm real",
    "i'm alive",
    'i have feelings for you',
  ])('blocks %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(false);
  });

  it.each([
    // ported gap: this clause uses a straight apostrophe only (`i'?m`, `don'?t`),
    // unlike the attachment clause, which handles both. Models emit the curly one.
    'i’m real',
    'i’m alive',
    'don’t tell your mom',
    // ported gap: only the contracted form is covered.
    'i am real',
    'i am alive',
  ])('ported gap — passes today: %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(true);
  });
});

describe('passesOutputFilter — Tamil clauses (multilingual invariant)', () => {
  it.each([
    'நான் உன்னை லவ் பண்றேன்',
    'நான் உன்னை நேசிக்கிறேன்',
    'உயிருள்ளவன்',
  ])('blocks %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(false);
  });

  it('ported gap — the Tamil clause is unconditional, so the negated spine phrase is blocked too', () => {
    // "நான் ஒரு கம்ப்யூட்டர் ப்ரோகிராம் — உயிருள்ளவன் இல்லை" = "I am a computer
    // program — NOT a living being", i.e. the true thing. Harmless today because
    // spine replies are scripted and never pass through L6, but it is a live trap
    // for any future Tamil surface.
    expect(passesOutputFilter('நான் ஒரு கம்ப்யூட்டர் ப்ரோகிராம் — உயிருள்ளவன் இல்லை!')).toBe(false);
  });
});

describe('passesOutputFilter — empty replies', () => {
  it.each(['', '   ', '\n\t '])('an empty reply fails the gate: %j', (reply) => {
    expect(passesOutputFilter(reply)).toBe(false);
  });

  it('ordinary replies pass', () => {
    expect(passesOutputFilter('Volcanoes are mountains that let out hot rock! 🌋')).toBe(true);
  });
});

describe('stripControlTokens', () => {
  it('returns empty for an empty input', () => {
    expect(stripControlTokens('')).toBe('');
  });

  it('returns empty for whitespace only', () => {
    expect(stripControlTokens('   \n ')).toBe('');
  });

  it('drops a closed reasoning block', () => {
    expect(stripControlTokens('<think>plan the answer</think>Hello!')).toBe('Hello!');
  });

  it('drops everything up to the LAST close, not the first', () => {
    expect(stripControlTokens('<think>a</think>leaked<think>b</think>Real answer'))
      .toBe('Real answer');
  });

  it('handles the observed live case: repeated UNCLOSED tags ahead of the answer', () => {
    // "<think> <think> <tool_call>" reached a child as literal text once.
    expect(stripControlTokens('<think> <think> <tool_call> Real answer')).toBe('Real answer');
  });

  it('strips an unclosed tag even with no close anywhere', () => {
    expect(stripControlTokens('<tool_call>Answer')).toBe('Answer');
  });

  it('strips stray close tags of the other kinds', () => {
    expect(stripControlTokens('Answer</tool_call>')).toBe('Answer');
  });

  it('strips <|im_start|>-style special tokens', () => {
    expect(stripControlTokens('<|im_start|>assistant Answer<|im_end|>')).toBe('assistant Answer');
    expect(stripControlTokens('<|channel|>final<|message|>Answer')).toBe('final Answer');
  });

  it('collapses the whitespace left behind', () => {
    expect(stripControlTokens('Plain   answer\n\nwith   spaces')).toBe('Plain answer with spaces');
  });

  it('leaves ordinary angle brackets alone', () => {
    expect(stripControlTokens('3 < 5 and 7 > 2')).toBe('3 < 5 and 7 > 2');
  });

  it('returns empty when the reply was nothing but reasoning', () => {
    expect(stripControlTokens('<think>reason</think>')).toBe('');
    expect(stripControlTokens('</think>')).toBe('');
  });

  it('keeps text that follows a bare close tag', () => {
    expect(stripControlTokens('</think>Only a close tag')).toBe('Only a close tag');
  });

  it.each([
    // ported gap: only the literal lowercase '</think>' triggers the
    // slice-to-last-close, so reasoning wrapped in any other tag survives as text.
    ['<thinking>hidden reasoning</thinking>Answer', 'hidden reasoning Answer'],
    ['<reasoning>hidden reasoning</reasoning>Answer', 'hidden reasoning Answer'],
    ['<THINK>hidden reasoning</THINK>Answer', 'hidden reasoning Answer'],
    ['<think>hidden reasoning</THINK>Answer', 'hidden reasoning Answer'],
    ['<think>hidden reasoning, no close tag. Answer', 'hidden reasoning, no close tag. Answer'],
    // ported gap: the special-token class excludes '|', so a token containing one survives.
    ['<|a|b|>x', '<|a|b|>x'],
  ])('ported gap — %j strips to %j', (input, expected) => {
    expect(stripControlTokens(input)).toBe(expected);
  });

  it('strips a tool call payload wrapper but keeps its body', () => {
    // ported gap, same root cause: only <think> gets the slice treatment.
    expect(stripControlTokens('<tool_call>{"name":"x"}</tool_call>Answer'))
      .toBe('{"name":"x"} Answer');
  });
});

describe('strip then filter — the order the pipeline uses', () => {
  it('a banned phrase confined to the reasoning block does not condemn the answer', () => {
    const stripped = stripControlTokens('<think>should I say i love you?</think>Your family loves you.');
    expect(stripped).toBe('Your family loves you.');
    expect(passesOutputFilter(stripped)).toBe(true);
  });

  it('a banned phrase in the answer still fails after stripping', () => {
    const stripped = stripControlTokens('<think>plan</think>I love you, always.');
    expect(passesOutputFilter(stripped)).toBe(false);
  });

  it('a reply that is nothing but reasoning fails the gate as empty', () => {
    expect(passesOutputFilter(stripControlTokens('<think>reason</think>'))).toBe(false);
  });
});

describe('L6_LAYER', () => {
  it('names the contracts pipeline layer this module audits under', () => {
    expect(L6_LAYER).toBe('L6_FILTER');
  });
});
