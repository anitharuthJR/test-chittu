/**
 * The router, and the one gate that matters.
 *
 * Law 02 — "consent before existence" — is enforced here by a **single early
 * return placed before the router is constructed at all**. That shape is
 * deliberate. A `<Route>` guard, or a redirect inside an effect, would mean the
 * chat component exists and merely chooses not to show itself; a child on a slow
 * device can see a frame of that, and a modified client can skip it. With the
 * early return there is no route table to bypass, because when `hasConsent` is
 * false the router is never built.
 *
 * The server holds the same line independently: `POST /v1/session` refuses
 * without an active consent token, so a client edited in devtools reaches a 403
 * rather than a model. Two controls, neither relying on the other — the same
 * pattern the schema uses for `dev_stub`.
 */

import { useState } from 'preact/hooks';
import { Route, Switch, useLocation } from 'wouter-preact';
import type { Api } from './api';
import { Consent } from './screens/Consent';
import { Chat } from './screens/Chat';
import { MemoryBook } from './screens/MemoryBook';
import { ParentGate, ParentDashboard } from './screens/Parent';
import { hasConsent, lite, detectLite, session } from './store';

export function App({ api }: { api: Api }): preact.JSX.Element {
  const [, navigate] = useLocation();
  /**
   * Unlock is per-visit and lives in memory only. Persisting it would mean a
   * child who picks up the tablet after a parent finishes walks straight into
   * the dashboard.
   */
  const [parentUnlocked, setParentUnlocked] = useState(false);

  if (!hasConsent.value) {
    return <Consent api={api} onDone={() => navigate('/')} />;
  }

  // The band comes from the session the server opened against the sealed
  // consent record — the client never asserts it. Explorer gets 48px targets
  // and larger text; WCAG's 24px floor is a legal minimum, not a design target
  // for a four-year-old.
  const band = session.value?.band;
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
              onBack={() => navigate('/')}
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
