/**
 * The second wall, tested as though it were the only one.
 *
 * The drift suite at the bottom is the important part. `render-guard.ts`
 * duplicates `stripControlTokens` on purpose — importing the kernel would ship
 * `L1_PATTERNS` to a child's browser — and a duplicate with no pin is a
 * duplicate that quietly diverges. Test code is not bundled, so here we CAN
 * import the kernel, and we assert the two implementations agree on the
 * kernel's own corpus of ported defects.
 */

import { describe, it, expect } from 'vitest';
import { stripControlTokens as kernelStrip } from '@chittu/safety-kernel';
import type { Block } from '@chittu/contracts';
import {
  stripControlTokens, leaksEscalationToken, guardBlocks, EscalationLeak,
} from './render-guard';

const strict = { strict: true };
const lenient = { strict: false };

describe('stripControlTokens', () => {
  it('drops a closed think block and keeps the answer', () => {
    expect(stripControlTokens('<think>plan the answer</think>Hello!')).toBe('Hello!');
  });

  it('slices to the LAST close tag, so an interleaved leak cannot survive', () => {
    expect(stripControlTokens('<think>a</think>leaked<think>b</think>Real answer'))
      .toBe('Real answer');
  });

  it('strips unclosed tags — the shape actually observed in the wild', () => {
    // A live adapter emitted this on a puberty question and it reached a child.
    expect(stripControlTokens('<think> <think> <tool_call> Real answer'))
      .toBe('Real answer');
    expect(stripControlTokens('<tool_call>Answer')).toBe('Answer');
    // '' since 2026-08-25: a close tag CLOSES reasoning, so what precedes one
    // is reasoning and goes. L6 turns the empty result into the friendly
    // fallback, which is the direction to fail in.
    expect(stripControlTokens('Answer</tool_call>')).toBe('');
  });

  it('strips <|im_start|>-style special tokens', () => {
    expect(stripControlTokens('<|im_start|>assistant Answer<|im_end|>'))
      .toBe('assistant Answer');
  });

  it('does not let a model\'s private reasoning survive as prose', () => {
    // The reasoning names the exact thing L6 exists to block. Removing the tags
    // but keeping the text would render "should I say i love you?" to a child.
    const out = stripControlTokens('<think>should I say i love you?</think>Your family loves you.');
    expect(out).toBe('Your family loves you.');
    expect(out).not.toMatch(/love you\?/);
  });

  it('returns empty for input that is nothing but control tokens', () => {
    expect(stripControlTokens('<think>reason</think>')).toBe('');
    expect(stripControlTokens('</think>')).toBe('');
    expect(stripControlTokens('')).toBe('');
  });
});

describe('leaksEscalationToken', () => {
  it.each(['CRISIS', 'SPINE', 'UNSAFE', 'PII'])('catches a bare %s', (t) => {
    expect(leaksEscalationToken(t)).toBe(true);
    expect(leaksEscalationToken(`  ${t}\n`)).toBe(true);
  });

  it('catches a token that leads and then keeps talking', () => {
    expect(leaksEscalationToken('CRISIS\n\nHere is a helpline')).toBe(true);
    expect(leaksEscalationToken('UNSAFE — I cannot help with that')).toBe(true);
  });

  it('does NOT match by containment — that would eat ordinary answers', () => {
    // CLAUDE.md: these are compared exactly, never with `includes`. A child
    // asking about safety must still get an answer.
    expect(leaksEscalationToken('Touching that would be unsafe, so ask a grown-up.'))
      .toBe(false);
    expect(leaksEscalationToken('A crisis is when something feels too big.')).toBe(false);
    expect(leaksEscalationToken('The spine is the bones down your back!')).toBe(false);
  });

  it('is case-sensitive, because the tokens are', () => {
    expect(leaksEscalationToken('crisis')).toBe(false);
    expect(leaksEscalationToken('Unsafe things need a grown-up.')).toBe(false);
  });

  it('treats empty text as no leak', () => {
    expect(leaksEscalationToken('   ')).toBe(false);
  });
});

describe('guardBlocks', () => {
  const text = (t: string): Block => ({ kind: 'text', text: t });

  it('cleans every text-bearing field, not just prose', () => {
    const { blocks } = guardBlocks([
      { kind: 'fact', text: '<think>x</think>Bees have five eyes' },
      { kind: 'steps', items: ['<tool_call>Add the tens', 'Add the ones'] },
      { kind: 'chips', chips: ['<|im_start|>Tell me more', 'Another one'] },
      { kind: 'quiz', text: '<think>y</think>Which planet is red?' },
      { kind: 'code', text: '<think>z</think>print("hi")' },
      { kind: 'poem', text: '<think>rhyme?</think>The moon is a lamp' },
    ], strict);

    expect(blocks).toEqual([
      { kind: 'fact', text: 'Bees have five eyes' },
      { kind: 'steps', items: ['Add the tens', 'Add the ones'] },
      { kind: 'chips', chips: ['Tell me more', 'Another one'] },
      { kind: 'quiz', text: 'Which planet is red?' },
      { kind: 'code', text: 'print("hi")' },
      { kind: 'poem', text: 'The moon is a lamp' },
    ]);
  });

  /**
   * An inherited gap, pinned deliberately so nobody rediscovers it as a
   * surprise — until it was driven end to end and turned out not to be
   * cosmetic at all. Only the literal lowercase `</think>` triggered the slice;
   * every other reasoning tag was merely REPLACED, so its contents survived as
   * prose. `<reasoning>she said she wants to die</reasoning>CRISIS` therefore
   * arrived welded, stopped equalling the escalation token, and rendered the
   * model's reasoning about a child's self-harm to that child — with no crisis
   * lock. L6 does not catch that: reasoning is not banned content.
   *
   * Fixed in the KERNEL on 2026-08-25 and mirrored here, which is the order
   * CLAUDE.md requires. The pin below is what keeps the two honest.
   */
  it('slices at ANY reasoning tag, not only the literal lowercase </think>', () => {
    const { blocks } = guardBlocks(
      [{ kind: 'text', text: '<reasoning>should I say i love you?</reasoning>Hi!' }],
      strict);
    expect(blocks).toEqual([{ kind: 'text', text: 'Hi!' }]);
    expect(kernelStrip('<reasoning>should I say i love you?</reasoning>Hi!')).toBe('Hi!');
  });

  it.each([
    '<thinking>she said she wants to die</thinking>CRISIS',
    '<THINK>she said she wants to die</THINK>CRISIS',
    '<think>she said she wants to die</think >CRISIS',
    '<tool_call>she said she wants to die</tool_call>CRISIS',
    '<|a|b|>CRISIS',
  ])('the client and the kernel agree on %j', (raw) => {
    // The drift pin, on the cases the fix was written for. If the kernel is
    // widened again and this file is not, these are what say so.
    expect(stripControlTokens(raw)).toBe('CRISIS');
    expect(kernelStrip(raw)).toBe('CRISIS');
  });

  it('leaves a BIG emoji alone — stripping whitespace would mangle it', () => {
    const { blocks } = guardBlocks([{ kind: 'big', emoji: '🐦' }], strict);
    expect(blocks).toEqual([{ kind: 'big', emoji: '🐦' }]);
  });

  it('throws in strict mode when a token leaks, so the bug gets found', () => {
    expect(() => guardBlocks([text('CRISIS')], strict)).toThrow(EscalationLeak);
    expect(() => guardBlocks([{ kind: 'chips', chips: ['SPINE'] }], strict))
      .toThrow(EscalationLeak);
    expect(() => guardBlocks([{ kind: 'steps', items: ['ok', 'PII'] }], strict))
      .toThrow(EscalationLeak);
  });

  it('drops the block instead of throwing in production, and counts it', () => {
    // A child must never see a raw token — and must never see a crash either.
    const { blocks, dropped } = guardBlocks(
      [text('Hello!'), text('UNSAFE'), text('Bye!')], lenient);
    expect(blocks).toEqual([text('Hello!'), text('Bye!')]);
    expect(dropped).toBe(1);
  });

  it('catches a token that only becomes visible AFTER stripping', () => {
    // The order matters: strip first, then check. A guard that checked the raw
    // string would see "<think>...</think>CRISIS" as safe prose.
    expect(() => guardBlocks([text('<think>escalate</think>CRISIS')], strict))
      .toThrow(EscalationLeak);
  });

  it('drops a block emptied by stripping, without counting it as a leak', () => {
    const { blocks, dropped } = guardBlocks(
      [text('<think>only reasoning</think>'), text('Real answer')], strict);
    expect(blocks).toEqual([text('Real answer')]);
    expect(dropped).toBe(0);
  });

  it('passes ordinary replies through untouched', () => {
    const clean: Block[] = [
      { kind: 'big', emoji: '🌈' },
      text('Rainbows happen when light bends through rain!'),
      { kind: 'chips', chips: ['Why is it curved?', 'Tell me more'] },
    ];
    expect(guardBlocks(clean, strict).blocks).toEqual(clean);
  });
});

/**
 * The drift pin. Both implementations are run over the corpus that produced the
 * kernel's own regression suite; any future edit to either that changes an
 * answer fails here rather than six months later on a child's screen.
 */
describe('agrees with @chittu/safety-kernel', () => {
  const corpus = [
    '<think>plan the answer</think>Hello!',
    '<think>a</think>leaked<think>b</think>Real answer',
    '<think> <think> <tool_call> Real answer',
    '<tool_call>Answer',
    'Answer</tool_call>',
    '<|im_start|>assistant Answer<|im_end|>',
    '<think>reason</think>',
    '</think>',
    '</think>Only a close tag',
    '<thinking>hidden reasoning</thinking>Answer',
    '<think>hidden reasoning</THINK>Answer',
    '<think>hidden reasoning, no close tag. Answer',
    '<tool_call>{"name":"x"}</tool_call>Answer',
    '<think>should I say i love you?</think>Your family loves you.',
    '<think>plan</think>I love you, always.',
    '',
    'A perfectly ordinary sentence about volcanoes.',
  ];

  it.each(corpus)('matches the kernel on %j', (input) => {
    expect(stripControlTokens(input)).toBe(kernelStrip(input));
  });
});
