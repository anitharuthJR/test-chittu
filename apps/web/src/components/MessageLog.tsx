import { useEffect, useRef } from 'preact/hooks';
import type { Message } from '../store';
import { BlockRenderer } from './BlockRenderer';
import { TraceStrip } from './TraceStrip';

/**
 * `role="log"` + `aria-live="polite"` (§4.1), so a screen reader announces a
 * reply without interrupting whatever it was reading.
 *
 * Because replies are never streamed (§4.2 — L6 matches phrases and cannot
 * judge "i will" before it has seen "miss you"), each reply arrives as one
 * complete DOM insertion. That happens to be exactly what `aria-live` wants:
 * a streamed reply would have re-announced itself on every token.
 */
export function MessageLog(
  { messages, thinking, onChip, onForget }: {
    messages: readonly Message[];
    thinking: boolean;
    onChip: (text: string) => void;
    onForget: (memoryId: string) => void;
  },
): preact.JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1]?.id;

  useEffect(() => {
    // Optional-called, not assumed: jsdom does not implement scrollIntoView,
    // and neither do some embedded webviews. Scrolling is a nicety; throwing
    // inside an effect would take the whole chat down with it.
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [last, thinking]);

  return (
    <div class="msgs" role="log" aria-live="polite" aria-label="Your chat with Chittu">
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        switch (m.role) {
          case 'child':
            return <p key={m.id} class="msg msg--child">{m.text}</p>;

          case 'chittu':
            return (
              <div key={m.id} class="msg msg--chittu">
                <BlockRenderer
                  blocks={m.blocks}
                  onChip={onChip}
                  chipsEnabled={isLast && !thinking}
                />
                <TraceStrip trace={m.trace} layers={m.layers} />
              </div>
            );

          case 'memory':
            return (
              <p key={m.id} class="msg msg--memory">
                <span class="memory__cat">{m.memory.category}</span>
                I'll remember: {m.memory.fact}
                <button
                  type="button"
                  class="memory__forget"
                  onClick={() => onForget(m.memory.id)}
                >
                  Forget this
                </button>
              </p>
            );

          case 'system':
            return <p key={m.id} class="msg msg--system">{m.text}</p>;
        }
      })}

      {thinking && (
        /*
         * An honest waiting state, not fake text (§4.2). The bird is decorative
         * and hidden from assistive tech; the word "Thinking" is the part that
         * gets announced, and it is true.
         */
        <p class="thinking">
          <span class="thinking__bird" aria-hidden="true">🐦</span>
          <span class="thinking__word">Thinking…</span>
        </p>
      )}

      <div ref={end} />
    </div>
  );
}
