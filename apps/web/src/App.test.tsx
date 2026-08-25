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

/** Minimal but structurally real — the panels read every one of these. */
export const DASHBOARD = {
  child: { firstName: 'Meera', band: 'builder' as const, country: 'IN' as const, board: 'CBSE' },
  consent: {
    law: 'DPDP', method: 'dev_stub', status: 'active',
    issuedAt: '2026-08-01T00:00:00.000Z', expiresAt: null,
    scopes: { memory: true, learning: false },
  },
  stats: {
    sessions: 0, messages: 0, spines: 0, memories: 0,
    crisisLocked: false, firstSeen: null, lastSeen: null,
    readingAttempts: 0, readingWords: 0, readingHits: 0,
  },
  sessions: [], memories: [],
  flags: { safety: [], assist: [], gate: [] },
  helplines: { name: 'India', law: 'DPDP', consent: 'parental', lines: [] },
  learning: { optedIn: false, perChildQueueExists: false },
};

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
      resumed: false, crisisLock: false,
      // The server builds the welcome (D1/H); the client only renders it.
      welcome: {
        blocks: [
          { kind: 'big' as const, emoji: '🐦' },
          { kind: 'text' as const, text: "Hello! I'm Chittu. Ask me anything, or pick something below." },
        ],
        trace: 'SPINE · welcome',
      },
    })),
    ownMessages: vi.fn(async () => ({ restorable: true, note: null, turns: [] })),
    turn: vi.fn(),
    seal: vi.fn(),
    wholeSeal: vi.fn(),
    memories: vi.fn(async () => ({ memories: [] })),
    dashboard: vi.fn(async () => DASHBOARD),
    transcript: vi.fn(),
    helplines: vi.fn(),
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

  /**
   * The case this panel exists for: a parent opening the dashboard on their OWN
   * phone, where no chat session was ever opened in this tab.
   *
   * The first version read the crisis state from the in-memory signal that only
   * a turn in this tab sets, and the session id from `session.value` — null
   * here. So the panel did not render, and had it rendered the unlock button
   * would have done nothing. Both now come from the dashboard payload.
   */
  it('shows a paused chat to a parent who never opened one in this tab', async () => {
    globalThis.history.pushState({}, '', '/parent');
    const locked = {
      ...DASHBOARD,
      stats: { ...DASHBOARD.stats, crisisLocked: true },
      sessions: [{
        id: 'locked-session', band: 'builder' as const,
        startedAt: '2026-08-24T18:00:00.000Z', endedAt: null,
        msgCount: 4, crisisLock: true,
      }],
    };
    const api = signedIn({
      verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
      dashboard: vi.fn(async () => locked),
      ackCrisis: vi.fn(async () => ({ crisisLock: false })),
    });
    render(<App api={api} />);

    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '4917' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    // session.value is null — nothing opened a chat in this tab.
    expect(session.value).toBeNull();
    const ack = await screen.findByRole('button', { name: /spoken with them/i });
    fireEvent.click(ack);

    // Targets the session the SERVER said is locked.
    await waitFor(() => expect(api.ackCrisis).toHaveBeenCalledWith('locked-session'));
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

describe('reload', () => {
  const RESUMED = {
    sessionId: 'live-session', band: 'builder' as const, country: 'IN' as const,
    // No welcome on a resume: the conversation is repainted instead.
    resumed: true, crisisLock: false, welcome: null,
  };

  it('puts the earlier conversation back on screen', async () => {
    const api = signedIn({
      openSession: vi.fn(async () => RESUMED),
      ownMessages: vi.fn(async () => ({
        restorable: true, note: null,
        turns: [
          { seq: 1, role: 'child', text: 'why is the sky blue' },
          { seq: 2, role: 'chittu', text: 'Sunlight scatters blue light!' },
        ],
      })),
    });
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByText('why is the sky blue')).toBeTruthy());
    expect(screen.getByText('Sunlight scatters blue light!')).toBeTruthy();
    // ...and not the greeting, which would imply a fresh start.
    expect(screen.queryByText(/ask me anything, or pick something below/i)).toBeNull();
  });

  it('greets on a NEW session and does not ask for messages', async () => {
    const api = signedIn();
    render(<App api={api} />);
    await waitFor(() => expect(
      screen.getByText(/ask me anything, or pick something below/i)).toBeTruthy());
    expect(api.ownMessages).not.toHaveBeenCalled();
  });

  /**
   * The defect this whole change exists for. A child hits a crisis lock and
   * reloads; the page has no memory of the turn that locked it, so if the lock
   * came from local state only, the reload would be an escape.
   */
  it('re-applies a crisis lock the page never witnessed', async () => {
    const api = signedIn({
      openSession: vi.fn(async () => ({ ...RESUMED, crisisLock: true })),
      ownMessages: vi.fn(async () => ({ restorable: true, note: null, turns: [] })),
    });
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByText(/pause and find a grown-up/i)).toBeTruthy());
    // The composer is disabled, so the child cannot simply carry on.
    const input = screen.getByLabelText(/type a message to chittu/i) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('tells a teen their messages were not saved instead of showing a blank', async () => {
    const api = signedIn({
      openSession: vi.fn(async () => ({ ...RESUMED, band: 'thinker' as const })),
      ownMessages: vi.fn(async () => ({
        restorable: false,
        note: "We don't keep what you type, so your earlier messages aren't saved.",
        turns: [],
      })),
    });
    render(<App api={api} />);
    await waitFor(() => expect(screen.getByText(/aren't saved/i)).toBeTruthy());
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

/**
 * D1/H — "Scripted welcome + one warm memory if any".
 *
 * The client renders the welcome the SERVER built and holds no copy of its own.
 * Which stored fact may be spoken back to a child is an allowlist decision
 * (`welcomeMemory` in the kernel), and this screen is not allowed to make one —
 * it does not even fetch the memory list to open a session.
 */
describe('the welcome', () => {
  const welcomed = (text: string, trace = 'SPINE · welcome') => ({
    sessionId: '11111111-1111-4111-8111-111111111111',
    band: 'builder' as const, country: 'IN' as const,
    resumed: false, crisisLock: false,
    welcome: {
      blocks: [{ kind: 'big' as const, emoji: '🐦' }, { kind: 'text' as const, text }], trace,
    },
  });

  it('renders the scripted welcome the server sent', async () => {
    const api = signedIn({
      openSession: vi.fn(async () => welcomed("Hello! I'm Chittu. Ask me anything.")),
    });
    render(<App api={api} />);
    await waitFor(() =>
      expect(screen.getByText(/hello! i'm chittu\. ask me anything\./i)).toBeTruthy());
  });

  it('carries the warm memory when the server put one in', async () => {
    const api = signedIn({
      openSession: vi.fn(async () => welcomed(
        "Hello! I'm Chittu. You're back — I remember: has a cat named Mani. Ask me anything.",
        'SPINE · welcome + MEMORY',
      )),
    });
    render(<App api={api} />);
    await waitFor(() => expect(screen.getByText(/has a cat named mani/i)).toBeTruthy());
  });

  it('does not fetch the memory list to open a session', async () => {
    // The decision is the server's. A client that reads the whole list to pick
    // one has taken it back, and would take it back on a stale deploy too.
    const api = signedIn({
      openSession: vi.fn(async () => welcomed("Hello! I'm Chittu. Ask me anything.")),
    });
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    await settle();
    expect(api.memories).not.toHaveBeenCalled();
  });

  it('invents nothing when the server sends no welcome', async () => {
    // A stale API is the case this covers. Saying nothing is honest; a hard-coded
    // greeting in the client would be a second source of truth for scripted copy.
    const api = signedIn({
      openSession: vi.fn(async () => ({
        sessionId: '11111111-1111-4111-8111-111111111111',
        band: 'builder' as const, country: 'IN' as const,
        resumed: false, crisisLock: false, welcome: null,
      })),
    });
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    await settle();
    expect(messages.value).toHaveLength(0);
  });

  it('goes through the ordinary reply path, so the render guard covers it', async () => {
    // The welcome now carries stored text a model wrote, so it must not have a
    // rendering path of its own. It is pushed as a `chittu` message holding the
    // server's blocks verbatim — the same shape a turn produces — which is what
    // puts it through BlockRenderer's `guardBlocks`. A bespoke welcome renderer
    // would be a second output channel, and `speak()` is the standing reminder
    // of what those cost.
    const blocks = [
      { kind: 'big' as const, emoji: '🐦' },
      { kind: 'text' as const, text: "Hello! I'm Chittu. Ask me anything." },
    ];
    const api = signedIn({
      openSession: vi.fn(async () => ({
        sessionId: '11111111-1111-4111-8111-111111111111',
        band: 'builder' as const, country: 'IN' as const,
        resumed: false, crisisLock: false,
        welcome: { blocks, trace: 'SPINE · welcome' },
      })),
    });
    render(<App api={api} />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalled());
    await settle();

    expect(messages.value).toHaveLength(1);
    const m = messages.value[0]!;
    expect(m.role).toBe('chittu');
    // Verbatim: nothing reformatted, nothing added, nothing stripped here.
    expect('blocks' in m ? m.blocks : null).toEqual(blocks);
  });
});

/**
 * D4/UN — "Chat unlocked + gentle welcome-back message".
 *
 * The words are the server's (a kernel spine); this screen renders them into
 * the child's log. It is the LAST thing they see before typing again, so it is
 * a Chittu reply with a trace, not the `system` role — that role is our own UI
 * copy, an error or a lockout notice, and never a safety script.
 */
describe('the welcome-back after a crisis unlock', () => {
  const WELCOME_BACK = {
    blocks: [{
      kind: 'text' as const,
      text: '💛 Your grown-up checked in. Welcome back — gently does it. 🐦',
    }],
    trace: 'SPINE · welcome-back',
  };

  async function unlockAsParent(api: Api) {
    globalThis.history.pushState({}, '', '/parent');
    render(<App api={api} />);
    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '4917' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    fireEvent.click(await screen.findByRole('button', { name: /spoken with them/i }));
  }

  const lockedDashboard = {
    ...DASHBOARD,
    stats: { ...DASHBOARD.stats, crisisLocked: true },
    sessions: [{
      id: 'locked-session', band: 'builder' as const,
      startedAt: '2026-08-24T18:00:00.000Z', endedAt: null,
      msgCount: 4, crisisLock: true,
    }],
  };

  it('puts the scripted welcome-back into the chat the child comes back to', async () => {
    const api = signedIn({
      verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
      dashboard: vi.fn(async () => lockedDashboard),
      ackCrisis: vi.fn(async () => ({ crisisLock: false, welcomeBack: WELCOME_BACK })),
    });
    await unlockAsParent(api);

    await waitFor(() => expect(api.ackCrisis).toHaveBeenCalled());
    await settle();
    const last = messages.value[messages.value.length - 1];
    expect(last?.role).toBe('chittu');
    expect(JSON.stringify(last)).toContain('Your grown-up checked in');
  });

  it('renders it as a Chittu reply, not as our own UI copy', async () => {
    // `system` is an error or a lockout notice. A safety script rendered in that
    // role would be indistinguishable from a toast, at the moment it matters.
    const api = signedIn({
      verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
      dashboard: vi.fn(async () => lockedDashboard),
      ackCrisis: vi.fn(async () => ({ crisisLock: false, welcomeBack: WELCOME_BACK })),
    });
    await unlockAsParent(api);
    await waitFor(() => expect(api.ackCrisis).toHaveBeenCalled());
    await settle();

    expect(messages.value.filter((m) => m.role === 'system')).toHaveLength(0);
    const last = messages.value[messages.value.length - 1];
    expect(last && 'trace' in last ? last.trace : null).toBe('SPINE · welcome-back');
  });

  it('composes no welcome-back of its own when the server sends none', async () => {
    const api = signedIn({
      verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
      dashboard: vi.fn(async () => lockedDashboard),
      ackCrisis: vi.fn(async () => ({ crisisLock: false })),
    });
    await unlockAsParent(api);
    await waitFor(() => expect(api.ackCrisis).toHaveBeenCalled());
    await settle();

    expect(crisisLock.value).toBe(false);
    expect(JSON.stringify(messages.value)).not.toContain('Welcome back');
  });

  it('says nothing at all when the unlock FAILED', async () => {
    // A greeting after a refused unlock would tell a child the pause is over
    // when it is not.
    const api = signedIn({
      verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
      dashboard: vi.fn(async () => lockedDashboard),
      ackCrisis: vi.fn(async () => {
        throw new ApiError(403, 'a parent PIN is required', 'PARENT_REQUIRED');
      }),
    });
    await unlockAsParent(api);
    await waitFor(() => expect(api.ackCrisis).toHaveBeenCalled());
    await settle();

    expect(JSON.stringify(messages.value)).not.toContain('Welcome back');
    await waitFor(() => expect(screen.getByText(/enter your pin again to unlock/i)).toBeTruthy());
  });
});

/**
 * D5/SEAL — "Verify seal integrity / recompute every hash".
 *
 * Two buttons, deliberately. The per-session one answers about the conversation
 * open in THIS tab, and is null on a parent's own phone — the same shape of
 * defect the crisis panel had. The whole-chain one is what a parent is actually
 * asking, and it needs no session id at all.
 */
describe('verifying the seal', () => {
  const asParent = async (api: Api) => {
    globalThis.history.pushState({}, '', '/parent');
    render(<App api={api} />);
    const input = await screen.findByLabelText(/parent pin/i);
    fireEvent.input(input, { target: { value: '4917' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
  };

  const parentApi = (o: Partial<Api> = {}) => signedIn({
    verifyPin: vi.fn(async () => ({ ok: true, locked: false })),
    ...o,
  });

  it('checks every conversation, with no session open in this tab', async () => {
    const api = parentApi({
      wholeSeal: vi.fn(async () => ({ ok: true, sessions: 3, records: 42, broken: null })),
    });
    await asParent(api);
    fireEvent.click(await screen.findByRole('button', { name: /verify every conversation/i }));

    await waitFor(() => expect(api.wholeSeal).toHaveBeenCalled());
    // session.value is null — a parent on their own phone opened nothing.
    expect(session.value).toBeNull();
    expect(screen.getByText(/42 sealed records? across 3 conversations/i)).toBeTruthy();
  });

  it('names the conversation when the chain is broken', async () => {
    const api = parentApi({
      wholeSeal: vi.fn(async () => ({
        ok: false, sessions: 2, records: 9, broken: { sessionId: 'abc-123', seq: 4 },
      })),
    });
    await asParent(api);
    fireEvent.click(await screen.findByRole('button', { name: /verify every conversation/i }));

    await waitFor(() => expect(screen.getByText(/chain broken/i)).toBeTruthy());
    expect(screen.getByText(/abc-123/)).toBeTruthy();
  });

  it('keeps the per-session check', async () => {
    const api = parentApi({
      seal: vi.fn(async () => ({ ok: true, records: 6, brokenAt: null })),
    });
    await asParent(api);
    fireEvent.click(await screen.findByRole('button', { name: /^verify this conversation$/i }));
    await waitFor(() => expect(screen.getByText(/no chat has started yet/i)).toBeTruthy());
  });

  it('says so rather than claiming a pass when the check itself fails', async () => {
    const api = parentApi({
      wholeSeal: vi.fn(async () => { throw new Error('offline'); }),
    });
    await asParent(api);
    fireEvent.click(await screen.findByRole('button', { name: /verify every conversation/i }));
    await waitFor(() => expect(screen.getByText(/couldn't check the chain/i)).toBeTruthy());
  });
});

/**
 * D1 — the consent wizard's step counter.
 *
 * The last screen a parent sees before they decide whether to trust this, and
 * it announced "Step 8 of 7". Cosmetic, and cosmetic on this screen is not the
 * same as cosmetic.
 */
describe('the consent step counter', () => {
  const stepper = (c: Element) => c.querySelector('.stepper')!;

  async function startConsent() {
    const api = stubApi({
      methods: vi.fn(async () => ({
        country: 'IN' as const, methods: ['dev_stub' as const],
        offers: [{ method: 'dev_stub' as const, available: true }],
      })),
    });
    const r = render(<App api={api} />);
    await screen.findByText(/a grown-up sets this up/i);
    return r;
  }

  /** Fill whatever step `n` needs, then press Next. */
  function advance(n: number): void {
    if (n === 1) {
      fireEvent.input(screen.getByLabelText(/your name/i), { target: { value: 'Lakshmi' } });
      fireEvent.input(screen.getByLabelText(/your email/i), { target: { value: 'p@example.com' } });
    }
    if (n === 2) {
      fireEvent.input(screen.getByLabelText(/first name/i), { target: { value: 'Meera' } });
    }
    if (n === 4) fireEvent.click(screen.getByRole('button', { name: /builder/i }));
    if (n === 6) {
      fireEvent.input(screen.getByLabelText(/^pin \(4–6 digits\)$/i), { target: { value: '4917' } });
      fireEvent.input(screen.getByLabelText(/type it again/i), { target: { value: '4917' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
  }

  it('counts the verification gate — never "step 8 of 7"', async () => {
    const { container } = await startConsent();
    for (let n = 1; n <= 7; n++) advance(n);

    // The gate: the last screen, and the eighth.
    await waitFor(() => expect(screen.getByText(/prove you're the grown-up/i)).toBeTruthy());
    const label = stepper(container).getAttribute('aria-label');
    expect(label).toBe('Step 8 of 8');
  });

  it('counts the same total on every step, from the first', async () => {
    const { container } = await startConsent();
    expect(stepper(container).getAttribute('aria-label')).toBe('Step 1 of 8');
    advance(1);
    await waitFor(() =>
      expect(stepper(container).getAttribute('aria-label')).toBe('Step 2 of 8'));
  });

  it('shows as many dots as it announces', async () => {
    // A screen reader hearing "of 8" beside seven visible segments is the same
    // bug wearing a different hat.
    const { container } = await startConsent();
    const announced = Number(/of (\d+)/.exec(stepper(container).getAttribute('aria-label')!)![1]);
    expect(stepper(container).querySelectorAll('li')).toHaveLength(announced);
  });

  it('never announces a step past the total', async () => {
    const { container } = await startConsent();
    for (let n = 1; n <= 7; n++) advance(n);
    await waitFor(() => expect(screen.getByText(/prove you're the grown-up/i)).toBeTruthy());

    const [, at, total] = /Step (\d+) of (\d+)/
      .exec(stepper(container).getAttribute('aria-label')!)!;
    expect(Number(at)).toBeLessThanOrEqual(Number(total));
  });
});
