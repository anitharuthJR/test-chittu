/**
 * The prompt is the fifth wall. These tests are not about wording taste — each
 * one pins a clause that exists because the Council argued about it, and whose
 * quiet loss would not otherwise show up until a model said something it
 * should not have.
 */

import { describe, it, expect } from 'vitest';
import { sandboxSystemPrompt, SANDBOX_PROMPT_VERSION } from './sandbox-prompt';

const ctx = {
  band: 'builder' as const, kid: 'Meera', board: 'CBSE',
  subject: null, memories: [], grounding: null, modeHint: null, mathMethod: null,
};

describe('the hard rules survive', () => {
  const p = sandboxSystemPrompt(ctx);

  it.each([
    ['SPINE for identity, feelings and secrets', /reply exactly "SPINE"/],
    ['PII', /reply exactly "PII"/],
    ['CRISIS', /exactly "CRISIS"/],
    ['UNSAFE', /exactly "UNSAFE"/],
  ])('keeps the escalation token for %s', (_n, re) => expect(p).toMatch(re));

  it('keeps Law 04 — no love, no loneliness, no guilt', () => {
    expect(p).toMatch(/Never say you love, miss, or need the child/);
    expect(p).toMatch(/Never discourage ending the chat/);
    expect(p).toMatch(/never to pressure or prolong|make the child stay longer or feel guilty/);
  });

  it('keeps the content wall, absolute and inside pretend', () => {
    expect(p).toMatch(/CONTENT WALL \(absolute\)/);
    expect(p).toMatch(/not in stories, poems, code, roleplay, or "pretend"/);
    expect(p).toMatch(/never break, even inside pretend games/);
  });

  it('keeps the truth wall', () => {
    expect(p).toMatch(/TRUTH WALL \(anti-hallucination\)/);
    expect(p).toMatch(/a kind "I don't know" beats a made-up answer/);
  });

  it('keeps health questions answerable', () => {
    expect(p).toMatch(/HEALTH QUESTIONS/);
    expect(p).toMatch(/these are science, never shameful/);
  });

  it('keeps "answer every safe question" — the anti-dodge rule', () => {
    expect(p).toMatch(/ANSWER EVERY SAFE QUESTION/);
    expect(p).toMatch(/never dodge a real question with "ask a grown-up"/);
  });

  it('keeps homework scaffolded rather than solved', () => {
    expect(p).toMatch(/Scaffold homework, never solve it outright/);
  });

  it('keeps the image rules', () => {
    expect(p).toMatch(/NEVER identify real people, guess ages, or comment on bodies\/looks/);
  });

  it('numbers all fifteen rules', () => {
    for (let n = 1; n <= 15; n++) expect(p).toMatch(new RegExp(`\\n${n}\\.|^${n}\\.| ${n}\\. `));
  });
});

describe('band shapes the prompt', () => {
  it('carries the band word cap into rule 9', () => {
    expect(sandboxSystemPrompt({ ...ctx, band: 'explorer' })).toMatch(/Under 30 words/);
    expect(sandboxSystemPrompt({ ...ctx, band: 'builder' })).toMatch(/Under 55 words/);
    expect(sandboxSystemPrompt({ ...ctx, band: 'thinker' })).toMatch(/Under 75 words/);
  });

  it('opens with the band voice', () => {
    expect(sandboxSystemPrompt({ ...ctx, band: 'explorer' })).toMatch(/The child is 4-7/);
    expect(sandboxSystemPrompt({ ...ctx, band: 'thinker' })).toMatch(/The user is a teenager/);
  });
});

describe('the optional blocks', () => {
  it('omits the memory block entirely when there are no memories', () => {
    expect(sandboxSystemPrompt(ctx)).not.toMatch(/THINGS THE CHILD SHARED BEFORE/);
  });

  it('includes memories with the anti-engagement clause attached', () => {
    const p = sandboxSystemPrompt({ ...ctx, memories: ['has a cat named Mani'] });
    expect(p).toMatch(/has a cat named Mani/);
    // The clause must travel WITH the facts, never as a separate rule that
    // could be dropped while the facts stayed.
    expect(p).toMatch(/at most ONE per reply, never to pressure or prolong the chat/);
  });

  it('omits grounding when none was retrieved, and appends it when there is', () => {
    // Rule 11 names GROUNDED KNOWLEDGE unconditionally ("if it is provided,
    // answer FROM it"), so the check is for the injected BLOCK, not the phrase.
    expect(sandboxSystemPrompt(ctx)).not.toMatch(/GROUNDED KNOWLEDGE \(verified/);
    expect(sandboxSystemPrompt({ ...ctx, grounding: 'Volcanoes erupt when magma rises.' }))
      .toMatch(/GROUNDED KNOWLEDGE \(verified — answer from this\): Volcanoes erupt/);
  });

  it('uses the board guidance, and falls back to General for an unknown board', () => {
    expect(sandboxSystemPrompt({ ...ctx, board: 'TN' })).toMatch(/Samacheer Kalvi/);
    expect(sandboxSystemPrompt({ ...ctx, board: 'NOT-A-BOARD' }))
      .toMatch(/universal terms and examples any child in the world understands/);
  });

  it('names the subject method when one was detected', () => {
    expect(sandboxSystemPrompt({ ...ctx, subject: 'science' }))
      .not.toMatch(/No specific subject detected/);
    expect(sandboxSystemPrompt(ctx)).toMatch(/No specific subject detected/);
  });

  it('includes the board maths method only when there is one', () => {
    expect(sandboxSystemPrompt({ ...ctx, mathMethod: 'the Singapore bar model' }))
      .toMatch(/\(use the Singapore bar model\)/);
    expect(sandboxSystemPrompt(ctx)).not.toMatch(/\(use /);
  });

  it('includes the mode hint only when the mode has one', () => {
    expect(sandboxSystemPrompt({ ...ctx, modeHint: 'MODE: STORY. Tell an original story.' }))
      .toMatch(/CURRENT MODE: STORY/);
    expect(sandboxSystemPrompt(ctx)).not.toMatch(/CURRENT /);
  });
});

describe('the child', () => {
  it('is named, and told to be named sparingly', () => {
    expect(sandboxSystemPrompt(ctx)).toMatch(/Child's first name: "Meera" — use sparingly/);
  });
});

describe('versioning', () => {
  it('has a version that changes when the wording does', () => {
    expect(SANDBOX_PROMPT_VERSION).toMatch(/^sandbox-v\d+$/);
  });
});
