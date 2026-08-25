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

          case 'readcard':
            /*
             * The words are the PASSAGE's, and the marks are the SERVER's —
             * this renders what it was handed and judges nothing. A miss is
             * underlined as well as tinted, because colour alone is not a
             * signal every child can see.
             */
            return (
              <div key={m.id} class="readcard" aria-label="Read this aloud">
                {m.words.map((w, j) => (
                  <span
                    key={j}
                    class={`readcard__w${
                      w.hit === null ? '' : w.hit ? ' is-ok' : ' is-miss'}`}
                  >
                    {w.word}
                  </span>
                ))}
              </div>
            );

          case 'readscore':
            return <p key={m.id} class="readscore">{m.text}</p>;

          case 'childimage':
            /*
             * The child's own picture, in their own conversation. `src` is a
             * blob: URL into this page's memory — nothing was uploaded to a
             * place this could point at, and nothing survives the tab.
             *
             * The alt text says what it is without describing it: this side of
             * the wire has not seen the picture and must not invent a caption
             * for a screen reader. Chittu's reply, one message down, is the
             * description — written by a model that actually looked.
             */
            return (
              <figure key={m.id} class="imgprev">
                <img src={m.src} alt="The picture you showed Chittu" />
                <figcaption class="imgprev__note">Not saved</figcaption>
              </figure>
            );
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
