/**
 * Law 02 — "consent before existence" — as a test that can fail.
 *
 * These assert on something the gate uniquely causes: whether
 * `POST /v1/session` is ever CALLED. A client that reaches the network without
 * consent has already broken the law, regardless of what it rendered. A test
 * that only checked the DOM would pass whether or not the gate existed, because
 * an ungated chat with a stubbed API looks empty either way.
 *
 * The consent token is now an httpOnly cookie, so there is a second thing to
 * prove and it is easy to lose in a refactor: **the client never handles a
 * credential at all.** `holds no credential` below asserts that directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { App } from './App';
import type { Api } from './api';
import { ApiError } from './api';
import {
  consentState, profile, session, messages, memories, crisisLock, busy, mode,
} from './store';

const ACTIVE = {
  active: true as const, band: 'builder' as const,
  country: 'IN' as const, childFirstName: 'Meera',
};

function stubApi(overrides: Partial<Api> = {}): Api {
  return {
    health: vi.fn(async () => ({ status: 'ok' })),
    status: vi.fn(async () => ({ active: false as const })),
    methods: vi.fn(async () => ({ country: 'IN' as const, methods: [], offers: [] })),
    draft: vi.fn(),
    finalize: vi.fn(),
    verifyPin: vi.fn(async () => ({ ok: false, locked: false })),
    signOutParent: vi.fn(async () => ({ ok: true })),
    revoke: vi.fn(),
    openSession: vi.fn(async () => ({
      sessionId: '11111111-1111-4111-8111-111111111111',
      band: 'builder' as const, country: 'IN' as const,
    })),
    turn: vi.fn(),
    seal: vi.fn(),
    memories: vi.fn(async () => ({ memories: [] })),
    forget: vi.fn(),
    ackCrisis: vi.fn(),
    ...overrides,
  } as unknown as Api;
}

const signedIn = (o: Partial<Api> = {}) =>
  stubApi({ status: vi.fn(async () => ACTIVE), ...o });

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  // Signals are module-level, so a test that forgets this inherits the last
  // test's state — which would make the gate look like it works when it does not.
  consentState.value = 'unknown';
  profile.value = null;
  session.value = null;
  messages.value = [];
  memories.value = [];
  crisisLock.value = false;
  busy.value = false;
  mode.value = 'chat';
  globalThis.history.pushState({}, '', '/');
});

describe('Law 02 — the routing gate', () => {
  it('renders NEITHER the chat nor the consent form until the server answers', async () => {
    // The third state. `unknown` is not "signed out" — showing the seven-step
    // form to a family who already finished it would be its own bug — and it is
    // certainly not "signed in".
    const never = new Promise<never>(() => {});
    const api = stubApi({ status: vi.fn(() => never) as unknown as Api['status'] });
    render(<App api={api} />);
    await settle();

    expect(screen.getByText(/one moment/i)).toBeTruthy();
    expect(screen.queryByText(/a grown-up sets this up/i)).toBeNull();
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it('shows the consent flow when the server says there is no consent', async () => {
    render(<App api={stubApi()} />);
    await waitFor(() => expect(screen.getByText(/a grown-up sets this up/i)).toBeTruthy());
  });

  it('NEVER opens a session without an active consent', async () => {
    const api = stubApi();
    render(<App api={api} />);
    await settle();
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it.each(['/', '/memories', '/parent', '/parent/memories'])(
    'refuses to reach %s without consent — every route lands on the gate', async (path) => {
      globalThis.history.pushState({}, '', path);
      const api = stubApi();
      render(<App api={api} />);
      await settle();

      expect(screen.getByText(/a grown-up sets this up/i)).toBeTruthy();
      expect(api.openSession).not.toHaveBeenCalled();
      expect(api.memories).not.toHaveBeenCalled();
    });

  it('treats an unreachable server as NOT signed in', async () => {
    // An API that cannot be asked has not said yes. Failing open here would mean
    // an offline device is an ungated device.
    const api = stubApi({ status: vi.fn(async () => { throw new Error('offline'); }) });
    render(<App api={api} />);
    await waitFor(() => expect(screen.getByText(/a grown-up sets this up/i)).toBeTruthy());
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it('opens the chat once the server confirms consent', async () => {
    const api = signedIn();
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/i'm a computer program/i)).toBeTruthy();
  });

  it('opens exactly one session even though the effect can run twice', async () => {
    // Two sessions for one visit would fork the seal chain.
    const api = signedIn();
    const { rerender } = render(<App api={api} />);
    rerender(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    await settle();
    expect(api.openSession).toHaveBeenCalledTimes(1);
  });
});

describe('the client holds no credential', () => {
  it('never passes a token to openSession — the cookie carries it', async () => {
    const api = signedIn();
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    // Called with nothing, or at most a mode. If a token ever reappears in this
    // call it means the credential is back in JavaScript's hands.
    const args = (api.openSession as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(args.filter((a: unknown) => a !== undefined)).toHaveLength(0);
  });

  it('never passes a consent id to verifyPin', async () => {
    globalThis.history.pushState({}, '', '/parent');
    const api = signedIn();
    render(<App api={api} />);

    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(api.verifyPin).toHaveBeenCalled());
    // Exactly one argument: the PIN. A consent id was all it used to take to
    // erase an account, and the client no longer has one to leak.
    expect((api.verifyPin as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['1234']);
  });

  it('writes nothing to localStorage', async () => {
    const api = signedIn();
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    expect(globalThis.localStorage.length).toBe(0);
  });
});

describe('the parent PIN gate', () => {
  it('deep-linking to the parent memory book lands on the PIN, not the data', async () => {
    globalThis.history.pushState({}, '', '/parent/memories');
    const api = signedIn();
    render(<App api={api} />);
    await settle();

    expect(screen.getByText(/grown-ups only/i)).toBeTruthy();
    expect(api.memories).not.toHaveBeenCalled();
  });

  it('a wrong PIN does not unlock the dashboard', async () => {
    globalThis.history.pushState({}, '', '/parent');
    const api = signedIn({ verifyPin: vi.fn(async () => ({ ok: false, locked: false })) });
    render(<App api={api} />);

    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(screen.getByText(/that pin is not right/i)).toBeTruthy());
    expect(screen.queryByText(/parent dashboard/i)).toBeNull();
  });

  it('ends the server-side parent session on the way out', async () => {
    // Otherwise walking away leaves fifteen minutes of authority on the sofa.
    globalThis.history.pushState({}, '', '/parent');
    const api = signedIn({ verifyPin: vi.fn(async () => ({ ok: true, locked: false })) });
    render(<App api={api} />);

    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '4917' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    const back = await screen.findByRole('button', { name: /back to chittu/i });
    fireEvent.click(back);
    await waitFor(() => expect(api.signOutParent).toHaveBeenCalled());
  });

  it('says the session lapsed rather than "try again" when erasure needs a fresh PIN', async () => {
    globalThis.history.pushState({}, '', '/parent');
    const api = signedIn({
      verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
      revoke: vi.fn(async () => {
        throw new ApiError(403, 'a parent PIN is required', 'PARENT_REQUIRED');
      }),
    });
    render(<App api={api} />);

    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '4917' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    fireEvent.click(await screen.findByRole('button', { name: /revoke and erase/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes — erase everything/i }));

    await waitFor(() =>
      expect(screen.getByText(/please enter your pin again/i)).toBeTruthy());
  });
});

describe('band-aware surface', () => {
  it('marks the Explorer band so it gets 48px targets, not the 24px legal floor', async () => {
    const api = stubApi({
      status: vi.fn(async () => ({ ...ACTIVE, band: 'explorer' as const })),
    });
    const { container } = render(<App api={api} />);
    await waitFor(() => expect(container.querySelector('.band-explorer')).toBeTruthy());
  });

  it('knows the band before a session exists, so the first paint is right', async () => {
    // The band used to come only from `openSession`, which meant the very first
    // render used the wrong touch-target size for a four-year-old. It now comes
    // from /consent/status, which resolves first.
    const api = stubApi({
      status: vi.fn(async () => ({ ...ACTIVE, band: 'explorer' as const })),
      openSession: vi.fn(() => new Promise<never>(() => {})) as unknown as Api['openSession'],
    });
    const { container } = render(<App api={api} />);
    await waitFor(() => expect(container.querySelector('.band-explorer')).toBeTruthy());
    expect(session.value).toBeNull();
  });
});
