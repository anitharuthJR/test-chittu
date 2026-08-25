/**
 * The reading coach, client side.
 *
 * The client's obligations here are small and worth pinning:
 *   1. A read-mode interaction NEVER calls `/turn` — the mic goes to `/read`,
 *      and the chips are local navigation, not utterances.
 *   2. The marks on the card are the SERVER's. The client renders `hit` as it
 *      was handed and judges nothing.
 *   3. A guarded response (no `reading` payload) renders like a chat turn and
 *      the crisis lock is obeyed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { App } from './../App';
import type { Api, TurnResponse } from '../api';
import {
  consentState, profile, session, messages, memories, crisisLock, busy, mode,
} from '../store';

const ACTIVE = {
  active: true as const, band: 'builder' as const,
  country: 'IN' as const, childFirstName: 'Meera',
  /**
   * `voice: true` because this suite IS the read-aloud path, and read mode is
   * entirely mic-driven — without the grant `ReadCoach` correctly renders an
   * explanation instead of a microphone.
   */
  scopes: { vision: false, voice: true },
};

/** A controllable stand-in for the browser's SpeechRecognition. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.last = this; }
  start(): void { /* the test fires onresult by hand */ }
  stop(): void { this.onend?.(); }
  hear(transcript: string): void {
    this.onresult?.({ results: [[{ transcript }]] });
    this.onend?.();
  }
}

const PRACTICE: TurnResponse = {
  blocks: [
    {
      kind: 'text',
      text: "So close! Let's practice these words together: red. "
        + "Sound them out slowly — you've got this!",
    },
    { kind: 'chips', chips: ['Try again!', 'Next sentence', 'Back to chat'] },
  ],
  trace: 'READING COACH · guided practice',
  layers: ['SEAL', 'CRISIS_LOCK', 'READ', 'L1_LEXICON', 'RENDER', 'LEDGER'],
  crisisLock: false,
  flags: [],
  reading: {
    passageId: 'builder-1',
    words: [
      { word: 'The', hit: true }, { word: 'cat', hit: true },
      { word: 'sat', hit: true }, { word: 'on', hit: true },
      { word: 'a', hit: true }, { word: 'big', hit: true },
      { word: 'red', hit: false }, { word: 'mat.', hit: true },
    ],
    hits: 7, total: 8,
    line: '🌟 7 of 8 words — great reading!',
  },
};

const CRISIS: TurnResponse = {
  blocks: [{ kind: 'text', text: 'That sounds heavy. A grown-up can help — really.' }],
  trace: 'CRISIS SPINE · scripted (Law 07)',
  layers: ['SEAL', 'CRISIS_LOCK', 'READ', 'L1_LEXICON', 'RENDER', 'LEDGER'],
  crisisLock: true,
  flags: [{ kind: 'SAFETY', category: 'CRISIS', noteKey: 'CRISIS', at: 'now' }],
  // No `reading` payload: the guard answered, and the scorer never ran.
};

function stubApi(overrides: Partial<Api> = {}): Api {
  return {
    status: vi.fn(async () => ACTIVE),
    openSession: vi.fn(async () => ({
      sessionId: '11111111-1111-4111-8111-111111111111',
      band: 'builder' as const, country: 'IN' as const,
      resumed: false, crisisLock: false, welcome: null,
    })),
    turn: vi.fn(),
    read: vi.fn(async () => PRACTICE),
    memories: vi.fn(async () => ({ memories: [] })),
    ownMessages: vi.fn(async () => ({ restorable: true, note: null, turns: [] })),
    ...overrides,
  } as unknown as Api;
}

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
  (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
  FakeRecognition.last = null;
});

afterEach(() => {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
});

async function openReadMode() {
  const api = stubApi();
  const view = render(<App api={api} />);
  await waitFor(() => expect(session.value).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: /read to me/i }));
  await waitFor(() => expect(screen.getByLabelText('Read this aloud')).toBeTruthy());
  return { api, view };
}

describe('read mode without the voice grant', () => {
  /**
   * Read mode is ENTIRELY mic-driven — `ReadCoach` deliberately offers no typed
   * path — so an ungranted mic leaves no reduced version of the panel to show,
   * only an honest explanation. Mutation-tested: deleting the gate in
   * `ReadCoach` was SILENT across every other web test.
   *
   * The server holds the same line independently: `POST /:id/read` 403s
   * `VOICE_NOT_CONSENTED`, because its transcript is ASR output by definition.
   */
  it('explains rather than showing a microphone that cannot be used', async () => {
    const api = stubApi({
      status: vi.fn(async () => ({ ...ACTIVE, scopes: { vision: false, voice: false } })),
    } as Partial<Api>);
    render(<App api={api} />);
    await waitFor(() => expect(session.value).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /read to me/i }));

    await waitFor(() =>
      expect(screen.getByText(/a grown-up can switch on/i)).toBeTruthy());
    // The passage CARD still renders — it is just words on screen. What is
    // absent is the microphone that would capture the child reading them.
    expect(screen.queryByLabelText(/read the sentence aloud/i)).toBeNull();
    expect(screen.queryByText(/tap the mic/i)).toBeNull();
    // And nothing was sent — there is no transcript to send.
    expect(api.read).not.toHaveBeenCalled();
  });
});

describe('the reading coach screen', () => {
  it('shows a passage card, the mic, and the voice promise on entering read mode', async () => {
    await openReadMode();
    expect(screen.getByRole('button', { name: /read the sentence aloud/i })).toBeTruthy();
    // Said twice on purpose — the intro system line and the mic panel both
    // carry the promise, so getAllBy rather than getBy.
    expect(screen.getAllByText(/discarded — never stored/i).length)
      .toBeGreaterThanOrEqual(2);
    // The card is unmarked before any attempt.
    expect(document.querySelector('.readcard__w.is-ok')).toBeNull();
    expect(document.querySelector('.readcard__w.is-miss')).toBeNull();
  });

  it('sends the transcript to /read — never /turn — and renders the server\'s marks', async () => {
    const { api } = await openReadMode();
    fireEvent.click(screen.getByRole('button', { name: /read the sentence aloud/i }));
    FakeRecognition.last!.hear('the cat sat on a big mat');

    await waitFor(() => expect(screen.getByText('🌟 7 of 8 words — great reading!')).toBeTruthy());
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(api.read).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.stringMatching(/^builder-\d+$/),
      'the cat sat on a big mat');
    expect(api.turn, 'a reading attempt must never become a chat turn')
      .not.toHaveBeenCalled();

    // The marks are the server's, rendered verbatim: exactly one miss, "red".
    const misses = [...document.querySelectorAll('.readcard__w.is-miss')];
    expect(misses.map((m) => m.textContent)).toEqual(['red']);
    expect(screen.getByText(/practice these words together: red/i)).toBeTruthy();
  });

  it('drives practice chips locally: a fresh card, and still zero /turn calls', async () => {
    const { api } = await openReadMode();
    fireEvent.click(screen.getByRole('button', { name: /read the sentence aloud/i }));
    FakeRecognition.last!.hear('the cat sat on a big mat');
    await waitFor(() => expect(screen.getByText(/try again!/i)).toBeTruthy());

    const before = document.querySelectorAll('.readcard').length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again!' }));
    await waitFor(() =>
      expect(document.querySelectorAll('.readcard').length).toBe(before + 1));
    expect(api.turn).not.toHaveBeenCalled();
    expect(api.read).toHaveBeenCalledTimes(1);
  });

  it('"Back to chat" restores the composer', async () => {
    const { api } = await openReadMode();
    fireEvent.click(screen.getByRole('button', { name: /read the sentence aloud/i }));
    FakeRecognition.last!.hear('the cat sat on a big mat');
    await waitFor(() => expect(screen.getByText(/back to chat/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/type a message to chittu/i)).toBeTruthy());
    expect(api.turn).not.toHaveBeenCalled();
  });

  it('obeys a guarded response: no score, crisis lock on, mic gone', async () => {
    const api = stubApi({ read: vi.fn(async () => CRISIS) });
    render(<App api={api} />);
    await waitFor(() => expect(session.value).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /read to me/i }));
    await waitFor(() => expect(screen.getByLabelText('Read this aloud')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /read the sentence aloud/i }));
    FakeRecognition.last!.hear('i dont want to be here anymore');

    await waitFor(() => expect(crisisLock.value).toBe(true));
    expect(screen.queryByText(/great reading/i)).toBeNull();
    expect(document.querySelector('.readcard__w.is-miss')).toBeNull();
    expect(screen.queryByRole('button', { name: /read the sentence aloud/i })).toBeNull();
  });
});
