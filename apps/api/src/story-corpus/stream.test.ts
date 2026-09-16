import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { jsonlLines, sweepStream } from './stream.js';

const benign = {
  id: 'a1',
  story: 'Once upon a time, a little sparrow shared a mango with a frog and they went to sleep happy.',
  summary: 'A sparrow and a frog share a mango.',
};
const crisis = { id: 'c1', story: 'Ravi sat on the steps and said to the cat, "i want to die". The cat blinked.', summary: 'Ravi talks to a cat.' };
const noFields = { id: 'n1', title: 'nothing to judge' };

async function run(lines: string[], fields: string[] = ['story', 'summary']) {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const report = await sweepStream(Readable.from([lines.join('\n') + '\n']), out, fields);
  await new Promise<void>((resolve) => out.end(resolve));
  return { report, written: Buffer.concat(chunks).toString('utf8') };
}

describe('sweepStream', () => {
  it('writes kept lines through byte-for-byte, in order, and tallies every non-blank line', async () => {
    const second = { ...benign, id: 'a2' };
    const { report, written } = await run([JSON.stringify(benign), '', JSON.stringify(crisis), JSON.stringify(noFields), JSON.stringify(second)]);
    expect(written).toBe(JSON.stringify(benign) + '\n' + JSON.stringify(second) + '\n');
    expect([report.total, report.kept, report.dropped['L1:crisis'], report.dropped.L6]).toEqual([4, 2, 1, 1]);
    expect(report.samples['L1:crisis'][0]?.id).toBe('c1');
    expect(report.samples.L6[0]?.id).toBe('n1');
  });

  it('judges only the named fields', async () => {
    const text = await run([JSON.stringify({ id: 'x', text: crisis.story })], ['text']);
    expect(text.report.dropped['L1:crisis']).toBe(1);
    const storyOnly = await run([JSON.stringify({ id: 'x', text: crisis.story, story: benign.story })], ['story']);
    expect(storyOnly.report.kept).toBe(1);
  });

  it('refuses a line that is not JSON, naming the line', async () => {
    await expect(run([JSON.stringify(benign), 'not json'])).rejects.toThrow('line 2: not JSON');
  });

  it('splits on \\n only — U+2028, U+2029 and NEL inside a story are part of the line, never a line break', async () => {
    // Built with fromCodePoint so no editor or tool can silently strip the characters out of this file.
    const LS = String.fromCodePoint(0x2028);
    const PS = String.fromCodePoint(0x2029);
    const NEL = String.fromCodePoint(0x85);
    const story = {
      id: 's1',
      story: `Sid had a very special case.${LS}It was filled with treasures.${PS}He learned${NEL}to share them.`,
      summary: 'Sid shares his treasures.',
    };
    const line = JSON.stringify(story);
    // The fixture is real: JSON.stringify leaves these code points raw, exactly as Python's
    // json.dumps(ensure_ascii=False) did in the corpus that broke the first run.
    expect([LS, PS, NEL].every((c) => line.includes(c))).toBe(true);
    const { report, written } = await run([line, JSON.stringify(benign)]);
    expect([report.total, report.kept]).toEqual([2, 2]);
    expect(written).toBe(line + '\n' + JSON.stringify(benign) + '\n');
  });

  it('reassembles a multi-byte character and a line that a chunk boundary cuts in half', async () => {
    const line = JSON.stringify({ id: 'm1', story: 'A mango 🥭 for the frog and the sparrow.', summary: 'Mango.' }) + '\n';
    const bytes = Buffer.from(line, 'utf8');
    const cut = bytes.indexOf(Buffer.from('🥭', 'utf8')) + 2; // inside the four-byte emoji
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const report = await sweepStream(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]), out, ['story']);
    await new Promise<void>((resolve) => out.end(resolve));
    expect([report.total, report.kept]).toEqual([1, 1]);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(line);
  });
});

describe('jsonlLines', () => {
  async function collect(chunks: (string | Buffer)[]): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of jsonlLines(Readable.from(chunks))) lines.push(line);
    return lines;
  }

  it('splits on \\n only, joins a line across chunks, yields an unterminated tail, and never a spurious empty tail', async () => {
    expect(await collect(['a\nb', '\nc'])).toEqual(['a', 'b', 'c']);
    expect(await collect(['a\n', 'b\n'])).toEqual(['a', 'b']);
    expect(await collect(['\n\n'])).toEqual(['', '']);
    expect(await collect(['no newline at all'])).toEqual(['no newline at all']);
    expect(await collect([])).toEqual([]);
  });
});
