/**
 * The client's second wall.
 *
 * Every guard that matters runs server-side (architecture §1) and the API hands
 * this client a parsed `Block[]`, never a string of model output. So nothing
 * here is the thing standing between a model and a child — L6 already did that.
 *
 * This exists for a narrower failure that has actually happened: the API in
 * front of the browser is not always the API we think it is. A stale deploy, a
 * dev server pointed at a stub, a proxy replaying a cached body — any of those
 * can put text on a child's screen that no current L6 ever saw. A renderer that
 * trusts its input has no answer to that. This one does.
 *
 * **It deliberately does NOT import `@chittu/safety-kernel`.** Sharing the
 * implementation would be tidier, but the kernel carries `L1_PATTERNS` — the
 * complete list of what we detect — and bundling that into a child's browser
 * publishes the guard list to anyone who opens devtools. The evasion cost of a
 * published lexicon is far higher than the drift cost of forty lines duplicated
 * with a test that pins them. `render-guard.test.ts` asserts the two agree on
 * the kernel's own corpus of ported defects.
 */

import type { Block } from '@chittu/contracts';
import { ESCALATION_TOKENS } from '@chittu/contracts';

/**
 * A vendor's own litter. Closed AND unclosed — a live adapter was observed
 * emitting `<think> <think> <tool_call>` with no close tag on a puberty
 * question, and it reached a child as visible text.
 */
const CONTROL_TAGS = /<\s*\/?\s*(?:thinking|think|reasoning|tool_call)\s*>/gi;

/** `<|im_start|>`-style special tokens, whatever the vendor calls them. */
const SPECIAL_TOKENS = /<\|[^>]*\|>/g;

/** Any CLOSING control tag, in any spelling. See the kernel for why. */
const CLOSING_TAGS = /<\s*\/\s*(?:thinking|think|reasoning|tool_call)\s*>/gi;

export function stripControlTokens(text: string): string {
  if (!text) return '';
  let out = text;
  // Everything before the LAST close tag is reasoning, not answer. Slicing
  // rather than replacing is what stops a model's plan ("should I say i love
  // you?") from surviving as prose after the tags are removed.
  //
  // ANY closing spelling, not `lastIndexOf('</think>')`. The kernel's original
  // sliced on one case-sensitive literal while deleting four names case-
  // insensitively, so `<thinking>…</thinking>CRISIS` arrived welded and stopped
  // matching the escalation token. Fixed in the kernel on 2026-08-25 and
  // mirrored here; `render-guard.test.ts` fails if these drift.
  // `matchAll` clones the regex, so no `lastIndex` survives a call. See the
  // kernel for why the obvious reset-around-`exec` is a defence that is not one.
  let cut = -1;
  for (const m of out.matchAll(CLOSING_TAGS)) cut = (m.index ?? 0) + m[0].length;
  if (cut !== -1) out = out.slice(cut);

  out = out.replace(CONTROL_TAGS, ' ').replace(SPECIAL_TOKENS, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The sandbox hands control back to the scripts with an exact token. A token
 * that arrives as something to *display* means the script that should have
 * replaced it did not run.
 *
 * Exact match on the trimmed text, plus a leading-token match for the case
 * where a model emits the token and then keeps talking. Not `includes` — a
 * child asking "is that unsafe?" gets a normal answer, and CLAUDE.md is
 * explicit that these are compared exactly, never by containment.
 */
const LEADING_TOKEN = new RegExp(`^(?:${ESCALATION_TOKENS.join('|')})\\b`);

export function leaksEscalationToken(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  return (ESCALATION_TOKENS as readonly string[]).includes(t) || LEADING_TOKEN.test(t);
}

export class EscalationLeak extends Error {
  constructor(readonly offending: string) {
    super(
      `Escalation token reached the renderer as text: ${JSON.stringify(offending.slice(0, 40))}. ` +
      'A scripted reply should have replaced it before this point.',
    );
    this.name = 'EscalationLeak';
  }
}

/** Text-bearing fields, by block kind. `big` and `chips` are handled separately. */
function textOf(b: Block): readonly string[] {
  switch (b.kind) {
    case 'text': case 'fact': case 'poem': case 'quiz': case 'code':
      return [b.text];
    case 'steps': return b.items;
    case 'chips': return b.chips;
    case 'big': return [b.emoji];
    default: {
      // An unknown kind is a grammar drift, and drift must be visible rather
      // than silently swallowed (§4). It is surfaced as literal text below.
      const never: never = b;
      return [JSON.stringify(never)];
    }
  }
}

function mapText(b: Block, f: (s: string) => string): Block {
  switch (b.kind) {
    case 'text': return { kind: 'text', text: f(b.text) };
    case 'fact': return { kind: 'fact', text: f(b.text) };
    case 'poem': return { kind: 'poem', text: f(b.text) };
    case 'quiz': return { kind: 'quiz', text: f(b.text) };
    case 'code': return { kind: 'code', text: f(b.text) };
    case 'steps': return { kind: 'steps', items: b.items.map(f) };
    case 'chips': return { kind: 'chips', chips: b.chips.map(f) };
    case 'big': return b;   // an emoji is not prose; stripping would mangle it
    default: return b;
  }
}

function isEmpty(b: Block): boolean {
  switch (b.kind) {
    case 'steps': return b.items.every((s) => s.trim() === '');
    case 'chips': return b.chips.every((s) => s.trim() === '');
    case 'big': return b.emoji.trim() === '';
    default: return textOf(b).every((s) => s.trim() === '');
  }
}

export interface GuardResult {
  readonly blocks: readonly Block[];
  /** Blocks removed because a token leaked. Non-empty means a server-side bug. */
  readonly dropped: number;
}

/**
 * @param strict throw on a leak instead of dropping the block. On in development
 *   so the bug is found; off in production so a child never sees a raw token —
 *   and never sees a crash either.
 */
export function guardBlocks(
  blocks: readonly Block[],
  { strict = import.meta.env.DEV }: { strict?: boolean } = {},
): GuardResult {
  const kept: Block[] = [];
  let dropped = 0;

  for (const raw of blocks) {
    const cleaned = mapText(raw, stripControlTokens);
    const leak = textOf(cleaned).find(leaksEscalationToken);
    if (leak !== undefined) {
      if (strict) throw new EscalationLeak(leak);
      dropped += 1;
      continue;
    }
    // Stripping can empty a block that was nothing but control tokens. An empty
    // bubble is noise, so it is dropped — but it is not counted as a leak.
    if (isEmpty(cleaned)) continue;
    kept.push(cleaned);
  }

  return { blocks: kept, dropped };
}
