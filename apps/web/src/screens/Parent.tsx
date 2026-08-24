/**
 * The parent surface: a PIN gate, then what the API can actually answer.
 *
 * **On what is missing, and why it is missing rather than mocked.** The
 * architecture (§4, W4) specifies a seven-panel dashboard. Four of those panels
 * — transcripts, safety flags, assist flags, the learning queue — need
 * `GET /v1/parent/dashboard`, which does not exist yet. They are named below as
 * "not built" instead of being filled with plausible-looking data, because a
 * parent surface that displays invented reassurance is worse than one that
 * displays nothing: the whole product claim is that a parent can *check*.
 *
 * The PIN is verified server-side (`POST /v1/consent/:id/pin/verify`), which is
 * the point — the prototype checked it in client JavaScript and any child who
 * opened devtools could read it. Five wrong tries, then a lockout the server
 * holds; this screen only reports what it is told.
 */

import { useState } from 'preact/hooks';
import type { Api } from '../api';
import { ApiError } from '../api';
import { consentId, crisisLock, forgetConsent, session } from '../store';

export function ParentGate(
  { api, onUnlocked, onBack }:
  { api: Api; onUnlocked: () => void; onBack: () => void },
): preact.JSX.Element {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    const id = consentId.value;
    if (id === null || working) return;
    setWorking(true);
    setMsg(null);
    try {
      const r = await api.verifyPin(id, pin);
      if (r.ok) { setPin(''); onUnlocked(); return; }
      setMsg(r.note ?? 'That PIN is not right.');
    } catch (e2) {
      // A 401 is the ordinary wrong-PIN path and arrives here as an ApiError
      // because the body is `{ok:false}` with a 401 status. The server returns
      // the same shape whether or not the consent exists, so there is nothing
      // here to distinguish and nothing to leak — including in this message.
      setMsg(e2 instanceof ApiError && e2.status !== 401
        ? 'Something went wrong checking that.'
        : 'That PIN is not right.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <main class="panel panel--gate">
      <form class="card" onSubmit={(e) => { void submit(e); }}>
        <h2>👪 Grown-ups only</h2>
        <p class="sub">Enter the PIN you chose when you set Chittu up.</p>
        <div class="field">
          <label for="ppin">Parent PIN</label>
          <input id="ppin" type="password" inputMode="numeric" autocomplete="current-password"
            minLength={4} maxLength={6} value={pin}
            onInput={(e) => setPin((e.currentTarget as HTMLInputElement).value)} />
        </div>
        {msg !== null && <p class="field__error" role="alert">{msg}</p>}
        <div class="card__actions">
          <button type="button" class="btn btn--secondary" onClick={onBack}>Back</button>
          <button type="submit" class="btn" disabled={pin.length < 4 || working}>
            {working ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </main>
  );
}

export function ParentDashboard(
  { api, onBack, onMemories }:
  { api: Api; onBack: () => void; onMemories: () => void },
): preact.JSX.Element {
  const [seal, setSeal] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  async function verifySeal(): Promise<void> {
    const s = session.value;
    if (s === null) { setSeal('No chat has started yet.'); return; }
    try {
      const r = await api.seal(s.sessionId);
      setSeal(r.ok
        ? `Chain verified — ${r.records} sealed record${r.records === 1 ? '' : 's'}, nothing altered.`
        : `Chain BROKEN at record ${r.brokenAt ?? '?'}. This should never happen; please tell us.`);
    } catch {
      setSeal("Couldn't check the chain just now.");
    }
  }

  async function unlockCrisis(): Promise<void> {
    const s = session.value;
    if (s === null) return;
    try {
      const r = await api.ackCrisis(s.sessionId);
      crisisLock.value = r.crisisLock;
      setNote('Chat is unlocked. Please stay nearby.');
    } catch {
      setNote("Couldn't unlock just now.");
    }
  }

  async function revoke(): Promise<void> {
    const id = consentId.value;
    if (id === null) return;
    try {
      const r = await api.revoke(id);
      setNote(`Consent revoked. ${r.sessionsEnded} live session${r.sessionsEnded === 1 ? '' : 's'} ended and everything has been erased.`);
      forgetConsent();
    } catch {
      setNote("Couldn't revoke just now. Please try again.");
    }
  }

  return (
    <main class="panel">
      <header class="panel__head">
        <h2>Parent dashboard</h2>
        <button type="button" class="chip" onClick={onBack}>Back to Chittu</button>
      </header>

      {note !== null && <p class="notice" role="status">{note}</p>}

      {crisisLock.value && (
        <section class="card card--crisis">
          <h3>⚠️ Chat is paused</h3>
          <p>
            Chittu detected something that needs a person, gave the scripted safety reply
            and stopped. <b>We are not telling you what was said</b> — we store the category
            only, never your child's words.
          </p>
          <p>Please talk to your child before you unlock this.</p>
          <button type="button" class="btn btn--coral" onClick={() => { void unlockCrisis(); }}>
            I've spoken with them — unlock
          </button>
        </section>
      )}

      <section class="card">
        <h3>📖 Memory book</h3>
        <p class="sub">Everything Chittu remembers, and a Forget button on every row.</p>
        <button type="button" class="btn btn--secondary" onClick={onMemories}>
          Open the memory book
        </button>
      </section>

      <section class="card">
        <h3>🔗 Tamper-evident record</h3>
        <p class="sub">
          Every turn is sealed into a hash chain. This recomputes it: if a single
          character had been altered or a record removed, the check fails.
        </p>
        <button type="button" class="btn btn--secondary" onClick={() => { void verifySeal(); }}>
          Verify the chain
        </button>
        {seal !== null && <p class="notice" role="status">{seal}</p>}
      </section>

      <section class="card card--muted">
        <h3>Not built yet</h3>
        <p class="sub">
          These are specified and deliberately empty rather than filled with sample data —
          a parent dashboard that shows invented reassurance defeats its own purpose.
        </p>
        <ul class="todo">
          <li>Full transcripts (with the teen carve-out) — needs <code>GET /v1/parent/dashboard</code></li>
          <li>Safety flags — category only, never quoted words</li>
          <li>Assist flags — moments that deserve a grown-up</li>
          <li>Learning-loop review queue</li>
          <li>Local crisis helplines — needs <code>GET /v1/helplines/:country</code></li>
        </ul>
      </section>

      <section class="card card--danger">
        <h3>Revoke consent and erase everything</h3>
        <p class="sub">
          Ends every live session and erases your child's data. This cannot be undone.
        </p>
        {!confirmRevoke ? (
          <button type="button" class="btn btn--coral" onClick={() => setConfirmRevoke(true)}>
            Revoke and erase…
          </button>
        ) : (
          <div class="card__actions">
            <button type="button" class="btn btn--secondary" onClick={() => setConfirmRevoke(false)}>
              Keep my account
            </button>
            <button type="button" class="btn btn--coral" onClick={() => { void revoke(); }}>
              Yes — erase everything
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
