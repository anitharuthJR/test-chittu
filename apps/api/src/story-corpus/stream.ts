/**
 * One pass over a JSONL corpus. Kept lines are written through UNCHANGED — the bytes that
 * came in are the bytes that go out — and every non-blank line is tallied. A line that is
 * not JSON is a hard error: the corpus is ours, so a malformed line means a broken
 * upstream step, not a record to skip.
 *
 * JSONL is delimited by '\n' and NOTHING ELSE. The first real run died here: node's
 * readline also breaks lines on U+2028 (LINE SEPARATOR), which four TinyStories carry
 * inside the story text, so one record became two non-JSON halves 656,744 lines in. The
 * splitter below is ours: it splits on '\n' only, and reassembles a multi-byte character
 * that a chunk boundary cuts in half. A '\n' cannot occur inside a JSON string (it is
 * always escaped), so this split is exact.
 */
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { emptyReport, joinFields, judgeStory, tally, type Report } from './sweep.js';

/** Each '\n'-terminated line without its terminator, then the unterminated tail if there is one. */
export async function* jsonlLines(input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  for await (const chunk of input) {
    carry += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let cut = carry.indexOf('\n');
    while (cut !== -1) {
      yield carry.slice(0, cut);
      carry = carry.slice(cut + 1);
      cut = carry.indexOf('\n');
    }
  }
  carry += decoder.end();
  if (carry !== '') yield carry;
}

export async function sweepStream(input: Readable, output: Writable, fields: readonly string[]): Promise<Report> {
  const report = emptyReport(fields);
  let lineNo = 0;
  for await (const line of jsonlLines(input)) {
    lineNo += 1;
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`line ${lineNo}: not JSON`);
    }
    const idValue = record['id'];
    const id = typeof idValue === 'string' ? idValue : null;
    const text = joinFields(record, fields);
    const verdict = judgeStory(text);
    tally(report, id, verdict, text);
    if (verdict.keep && !output.write(line + '\n')) await once(output, 'drain');
  }
  return report;
}
