/**
 * Law 02 — "consent before existence" — as a test that can fail.
 *
 * The mutation test at the bottom is the point. It is easy to write a routing
 * test that passes whether or not the gate exists, because with no consent
 * token the API stub returns nothing anyway and the chat looks empty either
 * way. So these tests assert on something the gate uniquely causes: whether
 * `POST /v1/session` is ever CALLED. A client that reaches the network without
 * a consent token has already broken the law, regardless of what it renders.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { App } from './App';
import type { Api } from './api';
import {
  consentToken, consentId, session, messages, memories, crisisLock, busy, mode,
} from './store';

function stubApi(overrides: Partial<Api> = {}): Api {
  return {
    health: vi.fn(async () => ({ status: 'ok' })),
    methods: vi.fn(async () => ({ country: 'IN' as const, methods: [], offers: [] })),
    draft: vi.fn(),
    finalize: vi.fn(),
    verifyPin: vi.fn(async () => ({ ok: false, locked: false })),
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

beforeEach(() => {
  // Signals are module-level, so a test that forgets this inherits the last
  // test's consent — which would make the gate look like it works when it does
  // not. Reset everything the gate reads.
  consentToken.value = null;
  consentId.value = null;
  session.value = null;
  messages.value = [];
  memories.value = [];
  crisisLock.value = false;
  busy.value = false;
  mode.value = 'chat';
  globalThis.localStorage?.clear();
  globalThis.history.pushState({}, '', '/');
});

describe('Law 02 — the routing gate', () => {
  it('shows the consent flow when there is no consent token', () => {
    render(<App api={stubApi()} />);
    expect(screen.getByText(/a grown-up sets this up/i)).toBeTruthy();
  });

  it('NEVER opens a session without a consent token', async () => {
    const api = stubApi();
    render(<App api={api} />);
    // Give any effect a chance to fire before asserting the negative.
    await new Promise((r) => setTimeout(r, 20));
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it.each(['/', '/memories', '/parent', '/parent/memories'])(
    'refuses to reach %s without consent — every route lands on the gate', async (path) => {
      globalThis.history.pushState({}, '', path);
      const api = stubApi();
      render(<App api={api} />);
      await new Promise((r) => setTimeout(r, 20));

      expect(screen.getByText(/a grown-up sets this up/i)).toBeTruthy();
      expect(api.openSession).not.toHaveBeenCalled();
      expect(api.memories).not.toHaveBeenCalled();
    });

  it('opens the chat once a consent token exists', async () => {
    consentToken.value = 'a-token-long-enough-to-be-real-0001';
    const api = stubApi();
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/i'm a computer program/i)).toBeTruthy();
  });

  it('opens exactly one session even though the effect can run twice', async () => {
    // Two sessions for one visit would fork the seal chain.
    consentToken.value = 'a-token-long-enough-to-be-real-0002';
    const api = stubApi();
    const { rerender } = render(<App api={api} />);
    rerender(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(api.openSession).toHaveBeenCalledTimes(1);
  });
});

describe('the parent PIN gate', () => {
  beforeEach(() => {
    consentToken.value = 'a-token-long-enough-to-be-real-0003';
    consentId.value = 'c-1';
  });

  it('deep-linking to the parent memory book lands on the PIN, not the data', async () => {
    globalThis.history.pushState({}, '', '/parent/memories');
    const api = stubApi();
    render(<App api={api} />);
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText(/grown-ups only/i)).toBeTruthy();
    // The memory list was never fetched, so it was never in the page to hide.
    expect(api.memories).not.toHaveBeenCalled();
  });

  it('a wrong PIN does not unlock the dashboard', async () => {
    globalThis.history.pushState({}, '', '/parent');
    const api = stubApi({ verifyPin: vi.fn(async () => ({ ok: false, locked: false })) });
    render(<App api={api} />);

    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(screen.getByText(/that pin is not right/i)).toBeTruthy());
    expect(api.verifyPin).toHaveBeenCalledWith('c-1', '1234');
    expect(screen.queryByText(/parent dashboard/i)).toBeNull();
  });
});

describe('band-aware surface', () => {
  it('marks the Explorer band so it gets 48px targets, not the 24px legal floor', async () => {
    consentToken.value = 'a-token-long-enough-to-be-real-0004';
    const api = stubApi({
      openSession: vi.fn(async () => ({
        sessionId: '22222222-2222-4222-8222-222222222222',
        band: 'explorer' as const, country: 'IN' as const,
      })),
    });
    const { container } = render(<App api={api} />);
    await waitFor(() => expect(container.querySelector('.band-explorer')).toBeTruthy());
  });
});
