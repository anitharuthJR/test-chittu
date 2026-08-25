import { useRef, useState } from 'preact/hooks';
import { speechRecognitionAvailable } from '../store';

/**
 * Text in, and voice where voice actually exists.
 *
 * §4.3, stated as a rule rather than a preference: speech recognition is
 * Chrome/Edge-prefixed, absent in Firefox and inconsistent in Safari, so the
 * mic is **hidden where it is unavailable and the absence is explained**.
 * Requirements §11.5 warns against overclaiming voice; a button that does
 * nothing is exactly that overclaim in UI form.
 *
 * The transcript is transcribed and discarded — it goes into the text field and
 * is never uploaded as audio, which is the same promise the prototype made.
 */
export interface SpeechEvent { readonly results: ArrayLike<ArrayLike<{ transcript: string }>> }
export interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export function newRecognition(): Recognition | null {
  const g = globalThis as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function Composer(
  { onSend, disabled, placeholder }: {
    onSend: (text: string) => void;
    disabled: boolean;
    placeholder?: string;
  },
): preact.JSX.Element {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const canHear = speechRecognitionAvailable();

  function submit(e: Event): void {
    e.preventDefault();
    const t = text.trim();
    if (t === '' || disabled) return;
    setText('');
    onSend(t);
  }

  function toggleMic(): void {
    if (listening) { rec.current?.stop(); return; }
    const r = newRecognition();
    if (!r) return;
    rec.current = r;
    r.lang = 'en-IN';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? '';
      // Into the field, not straight down the wire: the child sees what was
      // heard and can fix it before anything is sent.
      if (said !== '') setText(said);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    setListening(true);
    r.start();
  }

  return (
    <form class="composer" onSubmit={submit}>
      <label class="visually-hidden" for="composer-input">Type a message to Chittu</label>
      <input
        id="composer-input"
        class="composer__input"
        type="text"
        autocomplete="off"
        maxLength={2000}
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? 'Ask me anything…'}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      />

      {canHear && (
        <button
          type="button"
          class={`round mic${listening ? ' is-recording' : ''}`}
          aria-pressed={listening}
          aria-label={listening ? 'Stop listening' : 'Speak instead of typing'}
          disabled={disabled}
          onClick={toggleMic}
        >
          🎤
        </button>
      )}

      <button
        type="submit"
        class="round send"
        aria-label="Send"
        disabled={disabled || text.trim() === ''}
      >
        ➤
      </button>

      {!canHear && (
        <p class="composer__novoice">
          Talking to Chittu doesn't work in this browser yet — try Chrome, or type instead.
        </p>
      )}
    </form>
  );
}
