/**
 * The router, and the one gate that matters.
 *
 * Law 02 — "consent before existence" — is enforced by **early returns placed
 * before the router is constructed at all**. That shape is deliberate. A
 * `<Route>` guard, or a redirect inside an effect, would mean the chat component
 * exists and merely chooses not to show itself; a child on a slow device can see
 * a frame of that, and a modified client can skip it. Here there is no route
 * table to bypass, because unless the server has confirmed an active consent the
 * router is never built.
 *
 * **Three states, not a boolean.** The consent token is now an httpOnly cookie,
 * so the client cannot read it and cannot know at boot whether it has one — it
 * has to ask `/v1/consent/status`. `unknown` is therefore a real state, and it
 * renders neither the chat nor the consent flow: showing the seven-step form to
 * a family who already finished it would be its own bug, and showing the chat
 * before the answer arrives would be the Law 02 failure. Default-deny.
 *
 * The server holds the same line independently: `POST /v1/session` refuses
 * without a cookie that resolves to an active consent, so a client edited in
 * devtools reaches a 403 rather than a model. Two controls, neither relying on
 * the other — the same pattern the schema uses for `dev_stub`.
 */

import { useEffect, useState } from 'preact/hooks';
import { Route, Switch, useLocation } from 'wouter-preact';
import type { Api } from './api';
import { Consent } from './screens/Consent';
import { Chat } from './screens/Chat';
import { MemoryBook } from './screens/MemoryBook';
import { ParentGate, ParentDashboard } from './screens/Parent';
import { consentState, profile, lite, detectLite, session } from './store';

/** Ask the server who we are. The only source of truth about consent. */
export async function refreshConsent(api: Api): Promise<void> {
  try {
    const s = await api.status();
    if (s.active) {
      profile.value = {
        band: s.band, country: s.country, childFirstName: s.childFirstName,
      };
      consentState.value = 'active';
    } else {
      profile.value = null;
      consentState.value = 'none';
    }
  } catch {
    // Offline, or the API is down. NOT 'active' — an unreachable server is not
    // permission. The consent flow is the safe thing to show, and finishing it
    // will fail loudly rather than granting anything.
    consentState.value = 'none';
  }
}

export function App({ api }: { api: Api }): preact.JSX.Element {
  const [, navigate] = useLocation();
  /**
   * Mirrors the server's parent cookie so the UI knows which screen to show.
   * It is NOT the authorisation — every parent-only route re-checks the cookie
   * server-side, so flipping this in devtools reveals a dashboard whose every
   * button returns 403.
   */
  const [parentUnlocked, setParentUnlocked] = useState(false);

  useEffect(() => { void refreshConsent(api); }, [api]);

  if (consentState.value === 'unknown') {
    return (
      <main class="boot" role="status" aria-live="polite">
        <span class="boot__bird" aria-hidden="true">🐦</span>
        <p>One moment…</p>
      </main>
    );
  }

  if (consentState.value === 'none') {
    return <Consent api={api} onDone={() => { void refreshConsent(api); navigate('/'); }} />;
  }

  // The band comes from the session the server opened against the sealed
  // consent record — the client never asserts it. Explorer gets 48px targets
  // and larger text; WCAG's 24px floor is a legal minimum, not a design target
  // for a four-year-old.
  const band = profile.value?.band ?? session.value?.band;
  const classes = ['app'];
  if (lite.value) classes.push('is-lite');
  if (band) classes.push(`band-${band}`);

  return (
    <div class={classes.join(' ')}>
      <Switch>
        <Route path="/memories">
          <MemoryBook api={api} by="child" onBack={() => navigate('/')} />
        </Route>

        <Route path="/parent">
          {parentUnlocked ? (
            <ParentDashboard
              api={api}
              onBack={() => {
                // Ends the server-side parent session too, so walking away from
                // the dashboard actually ends it rather than leaving 15 minutes
                // of authority on the sofa.
                void api.signOutParent();
                setParentUnlocked(false);
                navigate('/');
              }}
              onMemories={() => navigate('/parent/memories')}
            />
          ) : (
            <ParentGate
              api={api}
              onUnlocked={() => setParentUnlocked(true)}
              onBack={() => navigate('/')}
            />
          )}
        </Route>

        <Route path="/parent/memories">
          {parentUnlocked ? (
            <MemoryBook api={api} by="parent" onBack={() => navigate('/parent')} />
          ) : (
            // Deep-linking past the PIN is the obvious thing to try. It lands
            // on the gate, not on the data.
            <ParentGate
              api={api}
              onUnlocked={() => setParentUnlocked(true)}
              onBack={() => navigate('/')}
            />
          )}
        </Route>

        <Route>
          <Chat
            api={api}
            onParentGate={() => navigate('/parent')}
            onMemoryBook={() => navigate('/memories')}
          />
        </Route>
      </Switch>
    </div>
  );
}

/** Called once at boot; separate so tests can set `lite` themselves. */
export function initLite(): void {
  lite.value = detectLite();
}
