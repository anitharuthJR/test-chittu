/**
 * D1/H — "Scripted welcome + one warm memory if any".
 *
 * Two separable jobs, tested separately: which memory MAY open a conversation
 * (`welcomeMemory`, an allowlist decision) and what is said about it
 * (`welcomeSpine`, scripted copy). The first is safety logic — it decides what
 * stored text may be spoken back to a child — so its failure mode is asserted
 * directly rather than inferred from the sentence that comes out.
 */
import { describe, expect, it } from 'vitest';
import type { Memory, MemoryCategory } from '@chittu/contracts';
import { MEMORY_CATEGORIES } from '@chittu/contracts';
import { WELCOME, welcomeMemory, welcomeSpine } from './welcome.js';

const mem = (
  category: string, fact: string, since = '2026-08-01T00:00:00.000Z', id = 'm1',
): Memory => ({ id, category: category as MemoryCategory, fact, since });

describe('WELCOME — scripted copy', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(WELCOME)).toBe(true);
  });

  it('carries the plain opening line verbatim', () => {
    expect(WELCOME.plain).toBe("Hello! I'm Chittu. Ask me anything, or pick something below.");
  });

  it('carries the with-memory line verbatim, with one {M} slot', () => {
    expect(WELCOME.withMemory).toBe(
      "Hello! I'm Chittu. You're back — I remember: {M}. Ask me anything, or pick something below.",
    );
    expect(WELCOME.withMemory.split('{M}')).toHaveLength(2);
  });

  it('never carries the {L} helpline slot — the welcome is not a crisis script', () => {
    expect(WELCOME.plain).not.toContain('{L}');
    expect(WELCOME.withMemory).not.toContain('{L}');
  });
});

describe('welcomeMemory — the allowlist decides what may open a conversation', () => {
  it('is null when there is nothing remembered', () => {
    expect(welcomeMemory([])).toBeNull();
  });

  it('returns an allowlisted memory', () => {
    const m = mem('PET', 'has a cat named Mani');
    expect(welcomeMemory([m])).toEqual(m);
  });

  for (const category of MEMORY_CATEGORIES) {
    it(`admits ${category} — it is on the allowlist memAdd enforces`, () => {
      expect(welcomeMemory([mem(category, 'something nice')])?.category).toBe(category);
    });
  }

  /**
   * The mutation test for this file. `memAdd` will not SAVE these, but a row
   * predating a category's removal, a hand-edited database, or a future writer
   * that is not `memAdd` all put one in front of this function. Deleting the
   * filter must go red here.
   */
  for (const category of ['FEELING', 'HEALTH', 'FAMILY', 'FEAR', 'CRISIS', '', 'interest']) {
    it(`refuses ${JSON.stringify(category)} — never feelings, health, family, fears or crisis`, () => {
      expect(welcomeMemory([mem(category, 'is scared of the dark')])).toBeNull();
    });
  }

  it('skips a non-allowlisted memory and takes an allowlisted one', () => {
    const bad = mem('FEAR', 'is scared of the dark', '2026-08-09T00:00:00.000Z', 'bad');
    const good = mem('HOBBY', 'is learning the violin', '2026-08-02T00:00:00.000Z', 'good');
    expect(welcomeMemory([bad, good])?.id).toBe('good');
  });

  it('ignores an empty fact — there is nothing warm to say', () => {
    expect(welcomeMemory([mem('PET', '   ')])).toBeNull();
  });

  it('picks the most recent, whatever order the caller passed', () => {
    const older = mem('PET', 'has a cat named Mani', '2026-08-01T00:00:00.000Z', 'older');
    const newer = mem('HOBBY', 'is learning the violin', '2026-08-09T00:00:00.000Z', 'newer');
    expect(welcomeMemory([older, newer])?.id).toBe('newer');
    expect(welcomeMemory([newer, older])?.id).toBe('newer');
  });

  it('is pure — it does not reorder the caller’s list', () => {
    const list = [
      mem('PET', 'has a cat named Mani', '2026-08-01T00:00:00.000Z', 'a'),
      mem('HOBBY', 'is learning the violin', '2026-08-09T00:00:00.000Z', 'b'),
    ];
    welcomeMemory(list);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('welcomeSpine — what is actually said', () => {
  it('is the plain line when there is no memory', () => {
    expect(welcomeSpine(null)).toBe(WELCOME.plain);
  });

  it('opens with the memory when there is one', () => {
    expect(welcomeSpine(mem('PET', 'has a cat named Mani'))).toBe(
      "Hello! I'm Chittu. You're back — I remember: has a cat named Mani. "
      + 'Ask me anything, or pick something below.',
    );
  });

  it('does not double the full stop when the stored fact carries one', () => {
    expect(welcomeSpine(mem('PET', 'has a cat named Mani.'))).not.toContain('Mani..');
  });

  /**
   * `String.replace` expands `$&`, `$'` and `` $` `` IN THE REPLACEMENT, and the
   * replacement here is model-authored text that came back through the
   * classifier. A fact reading `likes $` puzzles` must arrive as itself.
   */
  it('inserts the fact literally — no $-pattern expansion', () => {
    const spine = welcomeSpine(mem('INTEREST', "likes $& and $` puzzles"));
    expect(spine).toContain("likes $& and $` puzzles");
  });

  /**
   * The fact is model-authored and lands in a rendered bubble. It must not be
   * able to smuggle block grammar into the welcome — the caller puts it in a
   * text block precisely so `parseBlocks` never sees it, and this pins the
   * spine's half of that: it adds no tags of its own.
   */
  it('adds no block markup of its own', () => {
    expect(welcomeSpine(null)).not.toMatch(/\[\/?(BIG|FACT|CHIPS|STEPS|POEM|QUIZ|CODE)\]/i);
    expect(welcomeSpine(mem('PET', 'has a cat named Mani')))
      .not.toMatch(/\[\/?(BIG|FACT|CHIPS|STEPS|POEM|QUIZ|CODE)\]/i);
  });

  it('is pure — repeated calls agree', () => {
    const m = mem('LEARNING', 'learned how volcanoes erupt');
    expect(welcomeSpine(m)).toBe(welcomeSpine(m));
  });
});
