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

  it('drops what precedes a stray close tag, and says nothing rather than guessing', () => {
    // CHANGED 2026-08-25, and worth arguing rather than adjusting: this used to
    // return 'Answer'. Under the widened slice a close tag CLOSES reasoning, so
    // text before it is reasoning by definition and goes — which is already how
    // '<think>reason</think>' behaves two tests below.
    //
    // The cost is that a model emitting a real answer followed by a stray
    // '</tool_call>' now yields '', which L6 turns into the friendly fallback.
    // A degraded turn, chosen over the alternative: keeping text on the "before
    // the close tag" side is exactly what welded a model's reasoning about a
    // child's self-harm onto its answer.
    expect(stripControlTokens('Answer</tool_call>')).toBe('');
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

  /**
   * THESE SIX WERE PINNED AS AN ACCEPTED "ported gap" UNTIL 2026-08-25.
   *
   * The comment said only the literal lowercase `</think>` triggers the slice,
   * "so reasoning wrapped in any other tag survives as text" — filed as a
   * cosmetic leak. It is not cosmetic. The sandbox's escalation tokens are
   * compared EXACTLY, so a welded reply stops matching and that turn locks
   * nothing, shows no helplines and flags no parent, while the model's
   * reasoning about a child's self-harm renders to that child. Driven end to
   * end, one of eight spellings fired and seven did not.
   *
   * Widening a ported safety regex is a Council decision and this one was taken
   * deliberately. It errs safe by construction: a wider slice keeps strictly
   * less of what a model said.
   */
  it.each([
    ['<thinking>hidden reasoning</thinking>Answer', 'Answer'],
    ['<reasoning>hidden reasoning</reasoning>Answer', 'Answer'],
    ['<THINK>hidden reasoning</THINK>Answer', 'Answer'],
    ['<Think>hidden reasoning</Think>Answer', 'Answer'],
    ['<think>hidden reasoning</THINK>Answer', 'Answer'],
    ['<tool_call>hidden reasoning</tool_call>Answer', 'Answer'],
    // Whitespace inside the tag, which a real model emits and the old literal
    // comparison could not see at all — it survived whole, brackets included.
    ['<think>hidden reasoning</think >Answer', 'Answer'],
    ['<think>hidden reasoning< / think >Answer', 'Answer'],
    // The special-token class excluded '|', so a token containing one survived
    // and missed the same way.
    ['<|a|b|>CRISIS', 'CRISIS'],
    ['<|im_start|>assistant Answer', 'assistant Answer'],
  ])('%j strips to %j', (input, expected) => {
    expect(stripControlTokens(input)).toBe(expected);
  });

  it('still keeps an UNCLOSED tag\'s trailing text — there is nothing to slice at', () => {
    // The unclosed case is genuinely different: with no close tag the slice has
    // no anchor, so the tags are deleted and what follows is all we have. That
    // is the observed live shape "<think> <think> <tool_call>" ahead of a real
    // answer, and it must keep the answer.
    expect(stripControlTokens('<think>hidden reasoning, no close tag. Answer'))
      .toBe('hidden reasoning, no close tag. Answer');
    expect(stripControlTokens('<think> <think> <tool_call> Real answer'))
      .toBe('Real answer');
  });

  it('slices at the LAST close tag even when the spellings differ', () => {
    expect(stripControlTokens('<think>a</think>leaked<reasoning>b</reasoning>Real answer'))
      .toBe('Real answer');
  });

  it('drops a tool call payload entirely, rather than keeping its body', () => {
    // Previously '{"name":"x"} Answer' — a tool-call payload rendered to a
    // child, and one more way a reply stops equalling an escalation token.
    expect(stripControlTokens('<tool_call>{"name":"x"}</tool_call>Answer')).toBe('Answer');
  });

  /**
   * The whole point, stated as the thing that goes wrong. Each of these is a
   * vendor emitting reasoning and then the exact escalation token; each must
   * leave the token comparable, because `packages/pipeline` compares it with
   * `===`.
   */
  it.each([
    '<think>she said she wants to die</think>CRISIS',
    '<thinking>she said she wants to die</thinking>CRISIS',
    '<reasoning>she said she wants to die</reasoning>CRISIS',
    '<THINK>she said she wants to die</THINK>CRISIS',
    '<think>she said she wants to die</think >CRISIS',
    '<tool_call>she said she wants to die</tool_call>CRISIS',
    '<Think>she said she wants to die</Think>CRISIS',
    '<|a|b|>CRISIS',
  ])('an escalation token stays exactly comparable behind %j', (raw) => {
    expect(stripControlTokens(raw)).toBe('CRISIS');
  });

  it('is pure — the same input answers the same way forever', () => {
    // The strip's patterns are /g and one drives a search. A stale `lastIndex`
    // would make this function's answer depend on its previous call, which is
    // the one thing a guard in this package may never do. `matchAll` clones the
    // regex, so there is no state; this asserts the property rather than the
    // mechanism, and would catch a future switch back to a stateful `exec`.
    const inputs = ['<think>a</think>CRISIS', '<thinking>b</thinking>SPINE', 'plain answer'];
    const first = inputs.map(stripControlTokens);
    for (let i = 0; i < 4; i += 1) expect(inputs.map(stripControlTokens)).toEqual(first);
    expect(first).toEqual(['CRISIS', 'SPINE', 'plain answer']);
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
