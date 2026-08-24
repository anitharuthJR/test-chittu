/**
 * The one client component with a safety obligation (architecture §4, A4).
 *
 * It renders a typed AST that the server produced. It never receives a string
 * of model output and never builds one: no `innerHTML`, no
 * `dangerouslySetInnerHTML`, no `<div dangerously…>` equivalent anywhere in this
 * file or its children. A model that emits `<img onerror=alert(1)>` must become
 * inert text, and it does, because JSX children are text nodes.
 *
 * Three rules from §4, each with a test:
 *   1. Every text-bearing field passes through the render guard first.
 *   2. Escalation tokens never render — dev throws, prod drops the block.
 *   3. An unknown block kind renders as its own literal text, so a grammar
 *      drift is VISIBLE rather than silently swallowed.
 */

import type { JSX } from 'preact';
import type { Block } from '@chittu/contracts';
import { guardBlocks } from '../safety/render-guard';

export interface BlockRendererProps {
  readonly blocks: readonly Block[];
  /** Tapping a chip sends it as the child's next turn. */
  readonly onChip?: (text: string) => void;
  /** Chips from an older message are inert — the conversation has moved on. */
  readonly chipsEnabled?: boolean;
  /** Test seam. Defaults to `import.meta.env.DEV` inside the guard. */
  readonly strict?: boolean;
}

function One(
  { block, onChip, chipsEnabled }:
  { block: Block; onChip?: (t: string) => void; chipsEnabled: boolean },
): JSX.Element {
  switch (block.kind) {
    case 'text':
      return <p class="bubble">{block.text}</p>;

    case 'big':
      // Decorative. The reply's meaning is always in the text blocks beside it,
      // so a screen reader that skips this loses nothing (§4.1).
      return <div class="bigmoji" aria-hidden="true">{block.emoji}</div>;

    case 'fact':
      return (
        <div class="card card--fact">
          <span class="card__label">✨ Fun fact</span>
          <p>{block.text}</p>
        </div>
      );

    case 'steps':
      return (
        <div class="card card--steps">
          <span class="card__label">🪜 Step by step</span>
          <ol>{block.items.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      );

    case 'quiz':
      return (
        <div class="card card--quiz">
          <span class="card__label">🎯 Quiz</span>
          <p>{block.text}</p>
        </div>
      );

    case 'poem':
      return (
        <div class="card card--poem">
          <span class="card__label">✍️ Creation</span>
          <p class="poem__body">{block.text}</p>
        </div>
      );

    case 'code':
      // <pre><code> and nothing else. The text is a child node, so a snippet
      // containing markup is displayed, not executed.
      return (
        <div class="card card--code">
          <span class="card__label">💻 Code</span>
          <pre><code>{block.text}</code></pre>
        </div>
      );

    case 'chips':
      return (
        <div class="chips">
          {block.chips.map((c, i) => (
            <button
              key={i}
              type="button"
              class="chips__chip"
              disabled={!chipsEnabled}
              onClick={() => onChip?.(c)}
            >
              {c}
            </button>
          ))}
        </div>
      );

    default: {
      // Grammar drift. Rendering it as literal text is deliberate: a swallowed
      // unknown tag is a silent divergence between server and client, and the
      // first symptom would be a child seeing half a lesson.
      const unknown: never = block;
      return (
        <p class="bubble bubble--unknown">
          {JSON.stringify(unknown)}
        </p>
      );
    }
  }
}

export function BlockRenderer(
  { blocks, onChip, chipsEnabled = true, strict }: BlockRendererProps,
): JSX.Element {
  const { blocks: safe, dropped } = guardBlocks(
    blocks, strict === undefined ? {} : { strict });

  return (
    <>
      {safe.map((b, i) => (
        <One key={i} block={b} {...(onChip ? { onChip } : {})} chipsEnabled={chipsEnabled} />
      ))}
      {dropped > 0 && (
        // Every block was unrenderable. Better one honest UI sentence than a
        // blank bubble — and this is UI copy, not a safety script, so it does
        // not belong in the spines package.
        safe.length === 0 && (
          <p class="bubble bubble--error">
            Something went wrong with that answer. Ask me again?
          </p>
        )
      )}
    </>
  );
}
