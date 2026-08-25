import { useRef, useState } from 'preact/hooks';
import type { ImageInput, ImageMimeType } from '@chittu/contracts';
import { IMAGE_MAX_BYTES, IMAGE_MIME_TYPES } from '@chittu/contracts';
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

/**
 * A picked file, as base64 without the `data:` prefix — the shape the API takes.
 *
 * `FileReader` rather than `Blob.arrayBuffer()` + manual base64: the browser
 * already does this, and a hand-rolled encoder over a 4 MiB buffer is 4 MiB of
 * string concatenation on a phone.
 *
 * Refusals are returned, not thrown, and each one is a sentence a child can
 * read. The server checks all of this again — this is the courtesy copy, so a
 * picture that cannot work fails on the device instead of after a 5 MB upload
 * on a slow connection.
 */
export async function readImageFile(file: File): Promise<
  { ok: true; image: ImageInput } | { ok: false; why: string }
> {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, why: "I can only look at photos and drawings — try a JPG or PNG! 📷" };
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return { ok: false, why: 'That picture is a bit big — try a smaller one! 📷' };
  }
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    // `result` is `data:<mime>;base64,<payload>`; the API wants the payload.
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('unreadable'));
    r.readAsDataURL(file);
  });
  if (dataBase64 === '') return { ok: false, why: "I couldn't open that picture. Try another?" };
  return { ok: true, image: { mimeType: file.type as ImageMimeType, dataBase64 } };
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
  { onSend, onPickImage, hasImage, disabled, placeholder, canHearVoice }: {
    onSend: (text: string) => void;
    /**
     * A picture the child chose, already read and checked. Optional so the
     * composer still works everywhere it is used without one; the camera button
     * is simply absent when nobody is listening for pictures, which is the same
     * rule the mic follows — a button that does nothing is an overclaim in UI
     * form (§11.5).
     */
    onPickImage?: (image: ImageInput, previewUrl: string) => void;
    /** True when a picture is already waiting to go with the next message. */
    hasImage?: boolean;
    disabled: boolean;
    placeholder?: string;
    /**
     * Whether a grown-up granted the microphone. Absent means NOT granted.
     *
     * The camera follows this component's existing rule — no `onPickImage`, no
     * button — so vision is gated at the call site. The mic needs its own flag
     * because capability (`speechRecognitionAvailable`) and permission are two
     * different questions and BOTH must hold.
     */
    canHearVoice?: boolean;
  },
): preact.JSX.Element {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  /** Our own UI copy for a refused file. Never a safety script. */
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  /**
   * TWO INDEPENDENT REASONS THE MIC CAN BE ABSENT, and they are not the same
   * message. The browser may be unable to hear (Firefox, most of Safari), or a
   * grown-up may not have switched it on. Telling a child to "try Chrome" when
   * the real answer is "ask a grown-up" sends them to fix the wrong thing —
   * and the reverse sends a grown-up on an errand that cannot help.
   */
  const browserCanHear = speechRecognitionAvailable();
  const canHear = browserCanHear && canHearVoice === true;
  const canShow = onPickImage !== undefined;

  function submit(e: Event): void {
    e.preventDefault();
    const t = text.trim();
    if (t === '' || disabled) return;
    setText('');
    onSend(t);
  }

  /**
   * The picture is read here and handed UP, still only in memory.
   *
   * The input is reset on every path — including the failure paths — so picking
   * the same file twice in a row fires `change` the second time. Without that,
   * a child who picked a too-big photo, shrank it and picked it again would get
   * silence.
   */
  async function pickImage(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f || disabled) return;
    const r = await readImageFile(f);
    if (!r.ok) { setNote(r.why); return; }
    setNote(null);
    onPickImage?.(r.image, URL.createObjectURL(f));
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

      {canShow && (
        <>
          {/*
            * A real file input, driven by the button beside it.
            *
            * `display: none`, NOT `.visually-hidden` — and the difference is an
            * accessibility one rather than a cosmetic one. `.visually-hidden`
            * keeps an element in the accessibility tree, so a screen reader
            * announced BOTH this input ("Choose File") and the labelled button
            * that drives it: two controls for one action, one of them unlabelled
            * boilerplate. Found by reading the a11y tree of the running page,
            * which is also where the prototype landed (chittu-v3.html:115).
            *
            * `capture="environment"` asks a phone for the rear camera and is
            * ignored on a desktop, which falls back to the file picker — one
            * control, both devices, no capability sniffing.
            */}
          <input
            ref={file}
            id="composer-image"
            class="composer__file"
            type="file"
            accept={IMAGE_MIME_TYPES.join(',')}
            capture="environment"
            disabled={disabled}
            onChange={(e) => { void pickImage(e); }}
          />
          <button
            type="button"
            class={`round cam${hasImage === true ? ' is-armed' : ''}`}
            aria-label={hasImage === true
              ? 'Picture ready — type what you want to ask about it'
              : 'Show Chittu a picture'}
            disabled={disabled}
            onClick={() => file.current?.click()}
          >
            {hasImage === true ? '\u2705' : '\u{1F4F7}'}
          </button>
        </>
      )}

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

      {note !== null && <p class="composer__note" role="status">{note}</p>}

      {!browserCanHear && (
        <p class="composer__novoice">
          Talking to Chittu doesn't work in this browser yet — try Chrome, or type instead.
        </p>
      )}
      {browserCanHear && canHearVoice !== true && (
        <p class="composer__novoice">
          A grown-up can switch on talking to Chittu. For now, type away! ⌨️
        </p>
      )}
    </form>
  );
}
