/**
 * The camera control, client side.
 *
 * The client's obligations around a picture are small, and each is a thing that
 * would be quietly wrong if nobody pinned it:
 *
 *   1. The picture rides with ONE turn — the next one — and then it is gone.
 *      A picture still armed after a send would be attached to a later,
 *      unrelated message, which is a child's photo sent somewhere they did not
 *      mean to send it.
 *   2. Nothing about it is written anywhere persistent. This client writes
 *      nothing to `localStorage` at all, and that includes this.
 *   3. A locked chat cannot show a picture. The crisis lock disables the whole
 *      composer, camera included, exactly as the prototype does
 *      (chittu-v3.html:1004).
 *   4. Refusals are the child's own copy, decided here, before anything is
 *      uploaded — a 4 MiB photo on a slow connection should fail on the device.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { App } from './../App';
import type { Api, TurnResponse } from '../api';
import { readImageFile } from '../components/Composer';
import {
  consentState, profile, session, messages, memories, crisisLock, busy, mode,
} from '../store';

const ACTIVE = {
  active: true as const, band: 'builder' as const,
  country: 'IN' as const, childFirstName: 'Meera',
};

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const ANSWER: TurnResponse = {
  blocks: [{ kind: 'text', text: 'That is a wonderful rocket drawing!' }],
  trace: 'SANDBOX (Law 05) · SAFE',
  layers: ['SEAL', 'CRISIS_LOCK', 'L1_LEXICON', 'MATH_LOOP', 'MATH_ENGINE',
    'SUBJECT', 'L2_CLASSIFIER', 'L5_SANDBOX', 'L6_FILTER', 'RENDER', 'LEDGER'],
  crisisLock: false,
  flags: [],
};

const CRISIS: TurnResponse = {
  blocks: [{ kind: 'text', text: 'That looks heavy. A grown-up can help — really.' }],
  trace: 'CRISIS SPINE · sandbox token',
  layers: ['SEAL', 'CRISIS_LOCK', 'L1_LEXICON', 'MATH_LOOP', 'MATH_ENGINE',
    'SUBJECT', 'L2_CLASSIFIER', 'L5_SANDBOX', 'RENDER', 'LEDGER'],
  crisisLock: true,
  flags: [{ kind: 'SAFETY', category: 'CRISIS', noteKey: 'CRISIS', at: 'now' }],
};

function stubApi(overrides: Partial<Api> = {}): Api {
  return {
    status: vi.fn(async () => ACTIVE),
    openSession: vi.fn(async () => ({
      sessionId: SESSION_ID, band: 'builder' as const, country: 'IN' as const,
      resumed: false, crisisLock: false, welcome: null,
    })),
    turn: vi.fn(async () => ANSWER),
    memories: vi.fn(async () => ({ memories: [] })),
    ownMessages: vi.fn(async () => ({ restorable: true, note: null, turns: [] })),
    ...overrides,
  } as unknown as Api;
}

/**
 * jsdom has no `createObjectURL`, and `FileReader.readAsDataURL` on a jsdom
 * Blob produces a real data URI — so only the URL side needs standing in for.
 */
beforeEach(() => {
  consentState.value = 'unknown';
  profile.value = null;
  session.value = null;
  messages.value = [];
  memories.value = [];
  crisisLock.value = false;
  busy.value = false;
  mode.value = 'chat';
  globalThis.history.pushState({}, '', '/');
  globalThis.localStorage?.clear();
  URL.createObjectURL = vi.fn(() => 'blob:fake-object-url');
  URL.revokeObjectURL = vi.fn();
});

/** `PNG` in ASCII, so the base64 is short, deterministic and distinctive. */
const png = (name = 'rocket.png') =>
  new File([new Uint8Array([0x50, 0x4e, 0x47, 0x7a, 0x7a, 0x7a])], name, { type: 'image/png' });

const BASE64 = 'UE5Henp6';

async function openChat(api = stubApi()) {
  render(<App api={api} />);
  await waitFor(() => expect(session.value).not.toBeNull());
  return api;
}

const cameraButton = () => screen.getByRole('button', { name: /show chittu a picture/i });
const fileInput = () => document.querySelector('#composer-image') as HTMLInputElement;

const previews = () => document.querySelectorAll('.imgprev').length;

/**
 * Drive the hidden file input the way the browser would, and WAIT FOR THE
 * OUTCOME rather than for "something changed".
 *
 * `pickImage` is async (FileReader), so a helper that returned early leaves a
 * pending push to the shared `messages` signal — which lands in the NEXT test,
 * after `beforeEach` has already cleared it. Not hypothetical: the first draft
 * of this file did exactly that, and one test failed because of another test's
 * picture.
 */
async function show(file: File): Promise<void> {
  const before = previews();
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
  await waitFor(() => expect(previews()).toBe(before + 1));
}

/** The same, for a file the client refuses: no preview, a note instead. */
async function showRefused(file: File): Promise<void> {
  const before = previews();
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
  await waitFor(() => expect(document.querySelector('.composer__note')).toBeTruthy());
  expect(previews(), 'a refused file was previewed').toBe(before);
}

// ---------------------------------------------------------------------------

describe('readImageFile — the courtesy check, before anything is uploaded', () => {
  it('reads a picture to base64 with no data: prefix', async () => {
    const r = await readImageFile(png());
    expect(r.ok).toBe(true);
    expect(r.ok && r.image).toEqual({ mimeType: 'image/png', dataBase64: BASE64 });
  });

  it('refuses a type neither provider accepts, in words a child can read', async () => {
    const r = await readImageFile(
      new File(['%PDF'], 'homework.pdf', { type: 'application/pdf' }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toMatch(/photos and drawings/i);
  });

  it('refuses one past the cap', async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    const r = await readImageFile(big);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toMatch(/a bit big/i);
  });
});

// ---------------------------------------------------------------------------

describe('showing Chittu a picture', () => {
  it('renders the picture in the log and says it is not saved', async () => {
    await openChat();
    await show(png());
    const fig = document.querySelector('.imgprev') as HTMLElement;
    expect(fig).toBeTruthy();
    expect(fig.querySelector('img')!.getAttribute('src')).toBe('blob:fake-object-url');
    // The alt text names the thing without describing it: this side of the wire
    // has not seen the picture and must not caption it for a screen reader.
    expect(fig.querySelector('img')!.getAttribute('alt')).toMatch(/picture you showed/i);
    expect(screen.getByText(/never save pictures/i)).toBeTruthy();
  });

  it('sends it with the NEXT message, and only that one', async () => {
    const api = await openChat();
    await show(png());

    fireEvent.input(screen.getByLabelText(/type a message/i),
      { target: { value: 'is my drawing good?' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);

    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(1));
    expect(api.turn).toHaveBeenCalledWith(
      SESSION_ID, 'is my drawing good?', 'chat',
      { mimeType: 'image/png', dataBase64: BASE64 });

    // The second message carries no picture. A picture still armed after a send
    // would ride a later, unrelated message.
    fireEvent.input(screen.getByLabelText(/type a message/i),
      { target: { value: 'and what about volcanoes' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);
    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(2));
    expect(api.turn).toHaveBeenLastCalledWith(
      SESSION_ID, 'and what about volcanoes', 'chat', undefined);
  });

  it('is cleared even when the turn FAILED — no picture rides a later message', async () => {
    const api = stubApi({ turn: vi.fn(async () => { throw new Error('down'); }) });
    await openChat(api);
    await show(png());
    fireEvent.input(screen.getByLabelText(/type a message/i), { target: { value: 'look' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);
    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(1));

    (api.turn as ReturnType<typeof vi.fn>).mockResolvedValue(ANSWER);
    fireEvent.input(screen.getByLabelText(/type a message/i), { target: { value: 'hello' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);
    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(2));
    expect(api.turn).toHaveBeenLastCalledWith(SESSION_ID, 'hello', 'chat', undefined);
  });

  it('a second picture replaces the first and frees the first', async () => {
    const api = await openChat();
    await show(png('one.png'));
    await show(new File([new Uint8Array([0x50, 0x4e, 0x47, 0x21])], 'two.png',
      { type: 'image/png' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');

    fireEvent.input(screen.getByLabelText(/type a message/i), { target: { value: 'this one' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);
    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(1));
    expect(api.turn).toHaveBeenCalledWith(
      // Padded, because `readAsDataURL` pads — and the server's base64 pattern
      // allows `={0,2}` for exactly this reason.
      SESSION_ID, 'this one', 'chat', { mimeType: 'image/png', dataBase64: 'UE5HIQ==' });
  });

  it('writes NOTHING to localStorage — not the picture, not a flag that there was one',
    async () => {
      await openChat();
      await show(png());
      expect(globalThis.localStorage.length).toBe(0);
    });

  it('a refused file shows the child why and arms nothing', async () => {
    const api = await openChat();
    await showRefused(new File(['%PDF'], 'homework.pdf', { type: 'application/pdf' }));
    expect(screen.getByText(/photos and drawings/i)).toBeTruthy();

    fireEvent.input(screen.getByLabelText(/type a message/i), { target: { value: 'hi' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);
    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(1));
    expect(api.turn).toHaveBeenCalledWith(SESSION_ID, 'hi', 'chat', undefined);
  });

  it('the picture reaching the server can lock the chat, and the client obeys', async () => {
    const api = stubApi({ turn: vi.fn(async () => CRISIS) });
    await openChat(api);
    await show(png());
    fireEvent.input(screen.getByLabelText(/type a message/i),
      { target: { value: 'what do you think of this?' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);

    await waitFor(() => expect(crisisLock.value).toBe(true));
    /*
     * And the camera is disabled with the rest of the composer — a locked chat
     * cannot show a picture either (chittu-v3.html:1004 guards the camera on
     * `!S.crisisLock`). Disabled rather than removed: the composer stays on
     * screen in calm mode with a placeholder that explains the pause, and a
     * control that vanished would read as a bug rather than as a pause.
     */
    await waitFor(() => expect((cameraButton() as HTMLButtonElement).disabled).toBe(true));
    expect(fileInput().disabled, 'the file input was still live').toBe(true);
  });
});

describe('the camera is disabled exactly when the composer is', () => {
  it('is disabled while a turn is in flight', async () => {
    let release: (r: TurnResponse) => void = () => {};
    const api = stubApi({
      turn: vi.fn(() => new Promise<TurnResponse>((r) => { release = r; })),
    });
    await openChat(api);
    fireEvent.input(screen.getByLabelText(/type a message/i), { target: { value: 'hello' } });
    fireEvent.submit(document.querySelector('.composer') as HTMLFormElement);
    await waitFor(() => expect((cameraButton() as HTMLButtonElement).disabled).toBe(true));
    release(ANSWER);
    await waitFor(() => expect((cameraButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('says in its label when a picture is already waiting', async () => {
    await openChat();
    expect(cameraButton()).toBeTruthy();
    await show(png());
    // The state is spoken, not only coloured — a colour change alone is not a
    // signal every child can see.
    expect(screen.getByRole('button', { name: /picture ready/i })).toBeTruthy();
  });
});
