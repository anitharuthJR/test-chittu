/**
 * Visual block grammar — ported from prototype v3.3 `parseBlocks` (chittu-v3.html
 * lines 891-907) and the flattening in `addChittu` (line 925).
 *
 * This is the one place a model's output becomes UI, so it is also the last
 * place an injection could land. The prototype called `esc()` before writing
 * `innerHTML`; here we do something stronger and simpler — parse to a typed AST
 * and never produce markup at all. The client renders elements from these
 * objects, so a model emitting `<img onerror=...>` becomes inert text in a
 * `text` block rather than a DOM node.
 *
 * Quirks preserved deliberately (all verified against the prototype):
 *   - only the FIRST occurrence of each tag is extracted; the rest are stripped
 *   - BIG is truncated to 8 characters
 *   - CHIPS drops any chip longer than 30 characters, then keeps at most 3
 *   - STEPS keeps at most 8 items and does NOT apply the 30-char rule
 *   - CODE strips only leading/trailing blank lines, never inner whitespace
 *   - extraction order is BIG, FACT, CHIPS, STEPS, POEM, QUIZ, CODE
 *
 * Separators are NOT interchangeable (CLAUDE.md): STEPS and CHIPS split on '|';
 * the maths pictorial groups split on '·'. They collided once and truncated
 * lessons.
 */

import type { Block } from '@chittu/contracts';

/** Max characters kept from a [BIG] block — one or two emoji in practice. */
const BIG_MAX = 8;
/** A chip longer than this is dropped entirely, not truncated. */
const CHIP_MAX = 30;
const CHIP_LIMIT = 3;
const STEP_LIMIT = 8;

/** Item separator inside [STEPS] and [CHIPS]. Never '·'. */
export const ITEM_SEPARATOR = '|';

const TAG = (name: string) =>
  new RegExp(`\\[${name}\\]([\\s\\S]*?)\\[\\/${name}\\]`, 'i');

const ANY_TAG = /\[\/?(BIG|FACT|CHIPS|STEPS|POEM|QUIZ|CODE)\]/gi;

interface Extracted {
  readonly body: string;
  readonly rest: string;
}

/** First occurrence of a tag, plus the text with that occurrence removed. */
function extract(text: string, name: string): Extracted | null {
  const m = text.match(TAG(name));
  if (!m) return null;
  return { body: m[1] ?? '', rest: text.replace(m[0], ' ') };
}

/**
 * Parse a model reply into renderable blocks.
 *
 * The returned array is in RENDER order — prose first, then the visual blocks,
 * then chips last — which is the order the prototype appends them to the DOM
 * and the order the system prompt asks the model to compose in.
 */
export function parseBlocks(text: string): Block[] {
  let rest = text;
  const take = (name: string): string | null => {
    const got = extract(rest, name);
    if (!got) return null;
    rest = got.rest;
    return got.body;
  };

  // Extraction order matters: it is the prototype's, and CHIPS is pulled before
  // STEPS so a reply carrying both splits them from the correct substrings.
  const big = take('BIG');
  const fact = take('FACT');
  const chipsRaw = take('CHIPS');
  const stepsRaw = take('STEPS');
  const poem = take('POEM');
  const quiz = take('QUIZ');
  const code = take('CODE');

  const prose = rest.replace(ANY_TAG, ' ').replace(/\s+/g, ' ').trim();

  const blocks: Block[] = [];
  if (prose) blocks.push({ kind: 'text', text: prose });
  if (big !== null) {
    const emoji = big.trim().slice(0, BIG_MAX);
    if (emoji) blocks.push({ kind: 'big', emoji });
  }
  if (fact !== null) {
    const t = fact.trim();
    if (t) blocks.push({ kind: 'fact', text: t });
  }
  if (stepsRaw !== null) {
    const items = stepsRaw.split(ITEM_SEPARATOR)
      .map((s) => s.trim()).filter(Boolean).slice(0, STEP_LIMIT);
    if (items.length) blocks.push({ kind: 'steps', items });
  }
  if (poem !== null) {
    const t = poem.trim();
    if (t) blocks.push({ kind: 'poem', text: t });
  }
  if (quiz !== null) {
    const t = quiz.trim();
    if (t) blocks.push({ kind: 'quiz', text: t });
  }
  if (code !== null) {
    // only leading/trailing blank lines, so indentation inside survives
    const t = code.replace(/^\s*\n|\n\s*$/g, '');
    if (t) blocks.push({ kind: 'code', text: t });
  }
  if (chipsRaw !== null) {
    const chips = chipsRaw.split(ITEM_SEPARATOR)
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && c.length <= CHIP_MAX)
      .slice(0, CHIP_LIMIT);
    if (chips.length) blocks.push({ kind: 'chips', chips });
  }
  return blocks;
}

/** The prose with all markup removed — what the prototype's `stripBlocks` returns. */
export function stripBlocks(text: string): string {
  const blocks = parseBlocks(text);
  const first = blocks.find((b) => b.kind === 'text');
  return first?.kind === 'text' ? first.text : '';
}

/**
 * One-line rendering of a reply, for the seal chain and for text-to-speech.
 * Ported from `addChittu`'s `flat` (line 925) — the chain must hash what the
 * child was actually told, including the fact card and the chip labels, not
 * only the prose.
 */
export function flatten(blocks: readonly Block[]): string {
  let out = '';
  for (const b of blocks) {
    switch (b.kind) {
      case 'text': out += b.text; break;
      case 'fact': out += ' Fun fact: ' + b.text; break;
      case 'steps': out += ' Steps: ' + b.items.join('; '); break;
      case 'poem': out += ' ' + b.text; break;
      case 'quiz': out += ' Quiz: ' + b.text; break;
      case 'code': out += ' [code shown]'; break;
      case 'chips': out += ' [choices: ' + b.chips.join(' / ') + ']'; break;
      case 'big': break;   // the prototype omits the emoji from `flat`
    }
  }
  return out;
}
