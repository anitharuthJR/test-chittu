/**
 * The parent surface: a PIN gate, then what the API can actually answer.
 *
 * All seven panels of W4, backed by `GET /v1/parent/dashboard`. Nothing here is
 * sample data — the whole product claim is that a parent can *check*, and a
 * dashboard showing invented reassurance would defeat it.
 *
 * Two panels say something rather than showing nothing, which is the same
 * principle pointed the other way. The safety panel explains that it carries a
 * category and never a quote; the learning panel explains that there is no
 * per-child list because the insight table has no link back to a child. An
 * empty box would be read as "nothing has happened yet" in both cases.
 *
 * The PIN is verified server-side (`POST /v1/parent/pin/verify`), which is the
 * point — the prototype checked it in client JavaScript and any child who opened
 * devtools could read it. Five wrong tries, then a lockout the server holds;
 * this screen only reports what it is told.
 *
 * A correct PIN issues a 15-minute httpOnly parent-session cookie, and the two
 * destructive actions on this page — erasing the account and lifting a crisis
 * lock — require it server-side. Before that existed, erasing an account needed
 * only a consent id, and the client was keeping one where a child could read it.
 */

import { useEffect, useState } from 'preact/hooks';
import type { Api, DashboardResponse } from '../api';
import { ApiError } from '../api';
import { crisisLock, forgetConsent, session } from '../store';
import {
  StatsPanel, SafetyPanel, AssistPanel, HelplinePanel, LearningPanel, ConversationsPanel,
} from './dashboard-panels';

export function ParentGate(
  { api, onUnlocked, onBack }:
  { api: Api; onUnlocked: () => void; onBack: () => void },
): preact.JSX.Element {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    setMsg(null);
    try {
      // No consent id is sent. The server reads the consent cookie, and on a
      // correct PIN issues a second, short-lived cookie that the destructive
      // routes require. Nothing about that is visible to this component, which
      // is the point: it cannot forge what it cannot see.
      const r = await api.verifyPin(pin);
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
  const [d, setD] = useState<DashboardResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.dashboard()
      .then((r) => { if (live) setD(r); })
      .catch((e: unknown) => {
        if (!live) return;
        // The 15-minute parent session can lapse while this page sits open.
        // Saying which of the two happened is more use than "try again".
        setLoadErr(e instanceof ApiError && e.code === 'PARENT_REQUIRED'
          ? 'That took a while — please enter your PIN again.'
          : "Couldn't load the dashboard just now.");
      });
    return () => { live = false; };
  }, [api]);

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

  /**
   * Which session is actually locked, from the SERVER's answer.
   *
   * The first version read `session.value` — the session this browser tab
   * opened — which is null whenever a parent opens the dashboard on their own
   * phone. That is the main case this panel exists for, and the unlock button
   * silently did nothing in it.
   */
  const lockedSession = d?.sessions.find((x) => x.crisisLock)?.id ?? session.value?.sessionId ?? null;
  /** Same reason: the local signal is only set by a turn in THIS tab. */
  const isLocked = (d?.stats.crisisLocked ?? false) || crisisLock.value;

  async function unlockCrisis(): Promise<void> {
    if (lockedSession === null) {
      setNote('There is no paused conversation to unlock.');
      return;
    }
    try {
      const r = await api.ackCrisis(lockedSession);
      crisisLock.value = r.crisisLock;
      setNote('Chat is unlocked. Please stay nearby.');
      // Re-read, so the panel disappears and the flags reflect the acknowledgement.
      setD(await api.dashboard());
    } catch (e) {
      setNote(e instanceof ApiError && e.code === 'PARENT_REQUIRED'
        ? 'That took a while — please enter your PIN again to unlock.'
        : "Couldn't unlock just now.");
    }
  }

  async function revoke(): Promise<void> {
    try {
      const r = await api.revoke();
      setNote(`Consent revoked. ${r.sessionsEnded} live session${r.sessionsEnded === 1 ? '' : 's'} ended and everything has been erased.`);
      forgetConsent();
    } catch (e) {
      // PARENT_REQUIRED means the 15-minute parent session lapsed while this
      // page sat open. Say that, rather than "try again" at someone who would
      // keep trying.
      setNote(e instanceof ApiError && e.code === 'PARENT_REQUIRED'
        ? 'That took a while — please enter your PIN again to erase the account.'
        : "Couldn't revoke just now. Please try again.");
    }
  }

  return (
    <main class="panel">
      <header class="panel__head">
        <h2>Parent dashboard</h2>
        <button type="button" class="chip" onClick={onBack}>Back to Chittu</button>
      </header>

      {note !== null && <p class="notice" role="status">{note}</p>}

      {isLocked && (
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

      {loadErr !== null && <p class="field__error" role="alert">{loadErr}</p>}
      {d === null && loadErr === null && <p class="sub">Loading…</p>}

      {/*
        Summary before detail. A dashboard is scanned, not read top-to-bottom:
        the paused-chat panel above is the only thing that needs acting on right
        now, then the overview, then what needs attention, then the detail
        someone came looking for.
      */}
      {d !== null && (
        <>
          <StatsPanel d={d} />
          <SafetyPanel d={d} />
          <AssistPanel d={d} />
          <ConversationsPanel d={d} api={api} />
        </>
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


      {d !== null && (
        <>
          <HelplinePanel d={d} />
          <LearningPanel d={d} />
        </>
      )}

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
