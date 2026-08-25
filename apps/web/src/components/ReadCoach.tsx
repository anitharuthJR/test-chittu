import { useRef, useState } from 'preact/hooks';
import { newRecognition, type Recognition } from './Composer';
import { speechRecognitionAvailable } from '../store';

/**
 * The read-aloud panel: one big mic, honest microcopy, no text path.
 *
 * It REPLACES the composer in read mode, and that is a deliberate deviation
 * from the prototype, which kept the text input and answered typed text with
 * a nudge (chittu-v3.html:1051). A typed "attempt" is a path around the thing
 * being practised, and a typed sentence in read mode reached no guard at all
 * in the prototype — removing the input removes both problems at once.
 *
 * The transcript goes to the scorer the moment the browser produces it — the
 * prototype's `fromVoice` behaviour. There is no review-before-send here as
 * there is in the composer, because "fixing" a reading transcript by hand is
 * not correction, and the child sees exactly what was heard, word by word,
 * in the marks that come back.
 *
 * Same promise as the composer mic, said in the same breath: the browser
 * transcribes and DISCARDS — audio is never stored and never sent. And the
 * transcriber is browser ASR, a placeholder (status §4): adult-trained models
 * fail children, so where the browser cannot hear, the mic is absent and the
 * absence explained — never a button that does nothing.
 */
export function ReadCoach(
  { onTranscript, disabled, canHearVoice }: {
    onTranscript: (transcript: string) => void;
    disabled: boolean;
    /**
     * Whether a grown-up granted the microphone.
     *
     * Read mode is ENTIRELY mic-driven — there is deliberately no text path to
     * it — so without the grant there is no reduced version of this panel to
     * show, only an honest explanation. The server agrees independently:
     * `POST /:id/read` 403s `VOICE_NOT_CONSENTED`, because its `transcript` is
     * ASR output by definition.
     */
    canHearVoice?: boolean;
  },
): preact.JSX.Element {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const canHear = speechRecognitionAvailable();

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
      if (said !== '') onTranscript(said);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    setListening(true);
    r.start();
  }

  if (canHear && canHearVoice !== true) {
    return (
      <p class="composer__novoice">
        A grown-up can switch on talking to Chittu, and then we can read together! 📕
      </p>
    );
  }

  if (!canHear) {
    return (
      <p class="composer__novoice">
        Reading aloud doesn't work in this browser yet — try Chrome.
        Chittu never stores or sends your voice either way.
      </p>
    );
  }

  return (
    <div class="readmic">
      <button
        type="button"
        class={`round mic readmic__btn${listening ? ' is-recording' : ''}`}
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Read the sentence aloud'}
        disabled={disabled}
        onClick={toggleMic}
      >
        🎤
      </button>
      <p class="readmic__hint">
        {listening ? 'Listening — read the sentence!' : 'Tap the mic and read the sentence out loud!'}
        <span class="readmic__promise">
          Your voice is heard, checked, and discarded — never stored.
        </span>
      </p>
    </div>
  );
}
