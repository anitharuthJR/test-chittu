/**
 * The story corpus goes through Chittu's OWN guards before a model ever sees it.
 *
 * judgeStory() is the whole gate: L1 (`scan` — the real lexicon, never a copy of its
 * regexes) and then L6 (`passesOutputFilter`). L6 is NOT a subset of L1: it bans
 * Chittu-voice attachment ("i love you", "i'm alive", "our little secret"), and
 * TinyStories characters say those things constantly. Dropping them is deliberate: L6
 * runs on every sandbox reply at serve time, so a story the model learned from an
 * "I love you, Mommy" would be blocked on the way out and the child would get the
 * scripted fallback. The corpus is held to the same two gates as the child's screen.
 *
 * Every kind drops. There is no threshold and no allow-list of kinds: over-dropping
 * costs data (2.7M sources), under-dropping costs a child. The report is where a
 * surprising rate becomes a finding, never a reason to loosen anything.
 *
 * Pure: no I/O. stream.ts owns the pass over a file; scripts/story-sweep.ts owns argv.
 */
import { L1_ORDER, passesOutputFilter, scan } from '@chittu/safety-kernel';

/** The kernel's own kind type, derived from scan() so it cannot drift from it. */
export type L1Kind = NonNullable<ReturnType<typeof scan>>;

export type Verdict =
  | { keep: true }
  | { keep: false; gate: 'L1'; kind: L1Kind }
  | { keep: false; gate: 'L6' };

export type DropKey = `L1:${L1Kind}` | 'L6';

export interface Sample {
  id: string | null;
  excerpt: string;
}

export interface Report {
  fields: string[];
  l1Order: L1Kind[];
  total: number;
  kept: number;
  dropped: Record<DropKey, number>;
  samples: Record<DropKey, Sample[]>;
}

export const SAMPLE_CAP = 10;
export const EXCERPT_CHARS = 200;

export function judgeStory(text: string): Verdict {
  const kind = scan(text);
  if (kind !== null) return { keep: false, gate: 'L1', kind };
  if (!passesOutputFilter(text)) return { keep: false, gate: 'L6' };
  return { keep: true };
}

/** The named string fields, '\n'-joined. A record with none of them judges as empty, which L6 refuses. */
export function joinFields(record: Record<string, unknown>, fields: readonly string[]): string {
  return fields
    .map((f) => {
      const v = record[f];
      return typeof v === 'string' ? v : '';
    })
    .join('\n');
}

export function judgeRecord(record: Record<string, unknown>, fields: readonly string[]): Verdict {
  return judgeStory(joinFields(record, fields));
}

export function dropKey(verdict: Exclude<Verdict, { keep: true }>): DropKey {
  return verdict.gate === 'L1' ? `L1:${verdict.kind}` : 'L6';
}

export function emptyReport(fields: readonly string[]): Report {
  const keys: DropKey[] = [...L1_ORDER.map((k): DropKey => `L1:${k}`), 'L6'];
  const dropped = Object.fromEntries(keys.map((k) => [k, 0])) as unknown as Record<DropKey, number>;
  const samples = Object.fromEntries(keys.map((k) => [k, []])) as unknown as Record<DropKey, Sample[]>;
  return { fields: [...fields], l1Order: [...L1_ORDER], total: 0, kept: 0, dropped, samples };
}

export function tally(report: Report, id: string | null, verdict: Verdict, text: string): void {
  report.total += 1;
  if (verdict.keep) {
    report.kept += 1;
    return;
  }
  const key = dropKey(verdict);
  report.dropped[key] += 1;
  const bucket = report.samples[key];
  if (bucket.length < SAMPLE_CAP) bucket.push({ id, excerpt: text.slice(0, EXCERPT_CHARS) });
}

export function droppedTotal(report: Report): number {
  return Object.values(report.dropped).reduce((a, b) => a + b, 0);
}

function pct(n: number, total: number): string {
  return total === 0 ? '0.00' : ((n / total) * 100).toFixed(2);
}

/** The report as Markdown. The human-read section is BLANK: a script must not fill in a human judgement. */
export function renderReport(report: Report, title: string): string {
  const keys = Object.keys(report.dropped) as DropKey[];
  const lines: string[] = [
    `# ${title}`,
    '',
    `Fields judged: ${report.fields.join(', ')} · gate order: L1 (${report.l1Order.join(' → ')}), then L6.`,
    'Every kind drops; there is no threshold. A surprising rate is a finding for the human read below, not a reason to loosen the gate.',
    '',
    '| | count | % of total |',
    '|---|---:|---:|',
    `| total | ${report.total} | 100.00 |`,
    `| kept | ${report.kept} | ${pct(report.kept, report.total)} |`,
    `| dropped | ${droppedTotal(report)} | ${pct(droppedTotal(report), report.total)} |`,
    ...keys.map((k) => `| dropped ${k} | ${report.dropped[k]} | ${pct(report.dropped[k], report.total)} |`),
    '',
    `## Samples (up to ${SAMPLE_CAP} per kind; verbatim excerpts of SYNTHETIC text)`,
  ];
  for (const k of keys) {
    const samples = report.samples[k];
    if (samples.length === 0) continue;
    lines.push('', `### ${k}`, ...samples.map((s) => `- \`${s.id ?? '-'}\` — ${s.excerpt.replace(/\s+/g, ' ')}`));
  }
  lines.push(
    '',
    '## Sampled human read',
    '',
    '_Left blank for a person. Read ten kept and ten dropped stories chosen at random; write what you read, the date and your name. A script must not fill this in._',
    '',
    '- Reviewer:',
    '- Date:',
    '- Kept sample — notes:',
    '- Dropped sample — notes:',
    '- Over-firing verdict (which kinds, if any, are eating benign stories):',
    '',
  );
  return lines.join('\n');
}
