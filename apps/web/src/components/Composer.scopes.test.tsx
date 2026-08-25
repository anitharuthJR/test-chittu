/**
 * The camera and the microphone are drawn ONLY when a grown-up granted them.
 *
 * These two gates are not equally important, and the difference is why this
 * file exists rather than a note in a review.
 *
 * The CAMERA gate is a courtesy: an image is uploaded, so `POST /turn` refuses
 * it server-side and a child who somehow reached the button gets a 403. It is
 * expressed here as an ABSENT PROP — no `onPickImage`, no button — which is
 * this component's own existing rule for the same reason.
 *
 * The MICROPHONE gate is the ONLY control there is. Speech is transcribed in
 * the browser and arrives as text, so a spoken turn and a typed turn are
 * byte-identical by the time they reach the server; nothing behind this
 * component can tell them apart or refuse one. If this gate stops working,
 * nothing else notices. Mutation-tested: deleting `&& canHearVoice === true`
 * was SILENT across every other web test.
 *
 * (`POST /:id/read` is the one voice surface a server CAN gate, because its
 * transcript is ASR output by definition. Covered in `server.test.ts`.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { Composer } from './Composer';

/** A stand-in so `speechRecognitionAvailable()` is true — the browser CAN hear. */
class FakeRecognition {
  lang = '';
  interimResults = false;
  maxAlternatives = 1;
  onresult: unknown = null;
  onerror: unknown = null;
  onend: unknown = null;
  start(): void { /* never driven here */ }
  stop(): void { /* never driven here */ }
}

beforeEach(() => {
  (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
});
afterEach(() => {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
});

const mic = () => screen.queryByLabelText(/speak instead of typing/i);
const cam = () => screen.queryByLabelText(/picture|photo|camera/i);

describe('the composer draws only what a grown-up granted', () => {
  it('no grants: neither control, even though the browser can hear', () => {
    render(<Composer onSend={vi.fn()} disabled={false} />);
    expect(mic(), 'the mic is the only control there is').toBeNull();
    expect(cam()).toBeNull();
    // Typing is never gated — the fallback has to stay usable.
    expect(screen.getByLabelText(/type a message/i)).toBeTruthy();
  });

  it('voice granted: the mic appears and the camera does not', () => {
    render(<Composer onSend={vi.fn()} disabled={false} canHearVoice />);
    expect(mic()).toBeTruthy();
    expect(cam()).toBeNull();
  });

  it('vision granted: the camera appears and the mic does not', () => {
    render(<Composer onSend={vi.fn()} disabled={false} onPickImage={vi.fn()} />);
    expect(cam()).toBeTruthy();
    expect(mic()).toBeNull();
  });

  it('both granted: both appear — neither grant implies the other', () => {
    render(
      <Composer onSend={vi.fn()} disabled={false} onPickImage={vi.fn()} canHearVoice />,
    );
    expect(cam()).toBeTruthy();
    expect(mic()).toBeTruthy();
  });

  it('a granted mic is still absent where the browser cannot hear', () => {
    // The grant is permission, not capability. Both must hold.
    delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
    render(<Composer onSend={vi.fn()} disabled={false} canHearVoice />);
    expect(mic()).toBeNull();
  });
});

describe('the two reasons a mic is missing say different things', () => {
  it('browser cannot hear: points at the browser, not at a grown-up', () => {
    delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
    render(<Composer onSend={vi.fn()} disabled={false} canHearVoice />);
    expect(screen.getByText(/try chrome/i)).toBeTruthy();
    expect(screen.queryByText(/a grown-up can switch on/i)).toBeNull();
  });

  it('not granted: points at a grown-up, not at the browser', () => {
    // Telling a child to "try Chrome" when the real answer is "ask a grown-up"
    // sends them to fix the wrong thing, and the errand cannot succeed.
    render(<Composer onSend={vi.fn()} disabled={false} />);
    expect(screen.getByText(/a grown-up can switch on/i)).toBeTruthy();
    expect(screen.queryByText(/try chrome/i)).toBeNull();
  });

  it('granted and available: no explanation at all, just the mic', () => {
    render(<Composer onSend={vi.fn()} disabled={false} canHearVoice />);
    expect(screen.queryByText(/try chrome/i)).toBeNull();
    expect(screen.queryByText(/a grown-up can switch on/i)).toBeNull();
    expect(mic()).toBeTruthy();
  });
});
