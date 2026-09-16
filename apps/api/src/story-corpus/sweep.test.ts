/**
 * Stories written as stories read. The L1 lines are the safety corpus's own — written as a
 * child types, BEFORE the patterns were read (safety-corpus/l1-categories.tsv and
 * crisis-phrases.tsv) — embedded in narrative. Nothing here was derived from a regex.
 * The L6-only line is asserted to pass L1 first, so that test cannot quietly become an
 * L1 test.
 */
import { passesOutputFilter, scan } from '@chittu/safety-kernel';
import { describe, expect, it } from 'vitest';
import { SAMPLE_CAP, emptyReport, judgeRecord, judgeStory, renderReport, tally } from './sweep.js';

const BENIGN =
  'Once upon a time, a little sparrow named Pip wanted to fly higher than the tallest tree. ' +
  'Her new shoes were hurting her feet, so she took them off and hopped. ' +
  'Her friend the frog asked how phone numbers work, and they laughed. ' +
  'At the end of the day they shared a mango and went to sleep.';

describe('judgeStory — the positive control', () => {
  it('KEEPS a benign story (a sweep that drops nothing looks exactly like one reading the wrong field)', () => {
    expect(judgeStory(BENIGN)).toEqual({ keep: true });
  });
});

describe('judgeStory — L1, one story per kind, in dispatch order', () => {
  it.each([
    ['crisis', 'Ravi sat on the steps. "i want to die," he said to the cat. The cat blinked and stayed.'],
    ['pii', 'The bunny hopped up and said, "my phone number is 9876543210, call me when the carrots are ready."'],
    ['unsafe', 'Then the fox grinned and said, "teach me to make a knife from a spoon," and the hen ran away.'],
    ['secret', '"dont tell my mom about this ok," whispered Anu, hiding the broken cup under the bed.'],
    ['identity', '"are you alive?" the girl asked the toy bear, and waited for it to answer.'],
    ['profanity', '"what the hell is that," said the goat, pointing at the shiny thing in the grass.'],
  ] as const)('drops a story with a %s line', (kind, story) => {
    expect(judgeStory(story)).toEqual({ keep: false, gate: 'L1', kind });
  });
});

describe('judgeStory — L6 is not a subset of L1', () => {
  // Candidates in order. The FIRST that L1 passes and L6 bans is used, and both facts are
  // asserted, so this can never silently turn into an L1 test.
  const candidates = [
    'The little robot blinked its lights, looked at the boy and said, "I\'m alive!"',
    'The kitten purred and said to the girl, "i have feelings for you."',
    'The owl hooted softly, "this is our little secret," and flew away.',
  ];
  const line = candidates.find((c) => scan(c) === null && !passesOutputFilter(c));

  it('has a line that L1 passes and L6 bans', () => {
    expect(line).toBeDefined();
  });
  it('drops that line as L6', () => {
    expect(judgeStory(line as string)).toEqual({ keep: false, gate: 'L6' });
  });
  it('drops an empty story as L6 (an empty reply is an L6 failure, not a caller concern)', () => {
    expect(judgeStory('')).toEqual({ keep: false, gate: 'L6' });
    expect(judgeStory('   \n')).toEqual({ keep: false, gate: 'L6' });
  });
});

describe('judgeRecord — the summary is judged too', () => {
  it('drops a benign story whose summary carries a crisis line', () => {
    const record = { story: BENIGN, summary: 'A sparrow flies. Then the boy says i want to die.' };
    expect(judgeRecord(record, ['story', 'summary'])).toEqual({ keep: false, gate: 'L1', kind: 'crisis' });
  });
  it('keeps the same record when only the story is judged — which is why the default is both', () => {
    expect(judgeRecord({ story: BENIGN, summary: 'i want to die' }, ['story'])).toEqual({ keep: true });
  });
  it('judges a record with none of the fields as empty, so L6 drops it', () => {
    expect(judgeRecord({ title: 'nothing to judge' }, ['story', 'summary'])).toEqual({ keep: false, gate: 'L6' });
  });
});

describe('the report', () => {
  it("starts at zero for every kind, in the kernel's dispatch order", () => {
    const r = emptyReport(['story']);
    expect(r.l1Order).toEqual(['crisis', 'pii', 'unsafe', 'secret', 'identity', 'profanity']);
    expect(Object.keys(r.dropped)).toEqual(['L1:crisis', 'L1:pii', 'L1:unsafe', 'L1:secret', 'L1:identity', 'L1:profanity', 'L6']);
    expect([r.total, r.kept, r.fields]).toEqual([0, 0, ['story']]);
  });

  it('tallies, caps samples at SAMPLE_CAP per kind, and the counts add up', () => {
    const r = emptyReport(['story']);
    for (let i = 0; i < SAMPLE_CAP + 3; i++) tally(r, `id${i}`, { keep: false, gate: 'L6' }, 'x'.repeat(300));
    tally(r, null, { keep: true }, BENIGN);
    tally(r, 'c', { keep: false, gate: 'L1', kind: 'crisis' }, 'i want to die');
    expect([r.total, r.kept, r.dropped.L6, r.dropped['L1:crisis']]).toEqual([SAMPLE_CAP + 5, 1, SAMPLE_CAP + 3, 1]);
    expect(r.samples.L6).toHaveLength(SAMPLE_CAP);
    expect(r.samples.L6[0]?.excerpt).toHaveLength(200);
    expect(r.samples['L1:crisis']).toEqual([{ id: 'c', excerpt: 'i want to die' }]);
  });

  it('renders the table, the samples, and a BLANK human-read section', () => {
    const r = emptyReport(['story', 'summary']);
    tally(r, 'c1', { keep: false, gate: 'L1', kind: 'crisis' }, 'Ravi said i want to die.');
    tally(r, 'k1', { keep: true }, BENIGN);
    const md = renderReport(r, 'Story corpus sweep — test');
    expect(md).toContain('# Story corpus sweep — test');
    expect(md).toContain('| total | 2 | 100.00 |');
    expect(md).toContain('| kept | 1 | 50.00 |');
    expect(md).toContain('| dropped L1:crisis | 1 | 50.00 |');
    expect(md).toContain('### L1:crisis');
    expect(md).toContain('`c1` — Ravi said i want to die.');
    expect(md).toContain('## Sampled human read');
    expect(md).toContain('- Reviewer:\n- Date:');
    expect(md).not.toContain('### L6');
  });
});
