/**
 * W1 — consent and onboarding. Seven steps, then the verification gate —
 * eight screens, and the stepper counts all eight.
 *
 * Law 02 is "consent before existence", and this screen is where that is true
 * or not. Note what it does NOT do: it never holds a consent token, because
 * there is no longer one to hold — `finalize` sets an httpOnly cookie and
 * returns only the ledger. There is no path here that skips `finalize`, and no
 * way for this screen to grant itself anything.
 *
 * Two details that are policy, not styling:
 *   - **Memory defaults ON, learning defaults OFF** (requirements §4.1). The
 *     opt-in one is the one that shares anything.
 *   - **Unavailable verification methods are shown with the reason**, not
 *     hidden. A parent in a market we cannot serve deserves to know why rather
 *     than to see a shorter list and wonder.
 */

import { useEffect, useState } from 'preact/hooks';
import type { Band, Country } from '@chittu/contracts';
import { COUNTRIES } from '@chittu/contracts';
import type { Api, ConsentMethod, MethodOffer } from '../api';
import { ApiError } from '../api';
import { BAND_INFO, BOARD_GROUPS, COUNTRY_NAMES, METHOD_LABELS } from '../catalog';

/** The form steps. `step > STEPS` is the verification gate. */
const STEPS = 7;

/**
 * What a parent is actually counting: the seven form steps AND the gate.
 *
 * The stepper used to announce `Step ${step} of ${STEPS}`, so the last screen
 * before a family decides to trust this said "Step 8 of 7". Separate from
 * `STEPS` on purpose — `STEPS` is what the Next/Verify branch tests, and folding
 * the gate into it would turn a label fix into a control-flow change.
 */
const TOTAL_STEPS = STEPS + 1;

/**
 * The step a parent lands on coming back from a vendor-hosted ID check.
 *
 * Deliberately outside the 1..TOTAL_STEPS run: it is not part of the sequence a
 * parent walks, it is a place they arrive at. Folding it into the stepper would
 * make the count wrong for everybody who never takes this rail.
 */
const RETURN_STEP = 100;

/**
 * Did the browser just come back from the ID check?
 *
 * A bare flag in the return URL and nothing else. The consent id, the challenge
 * id and the verdict all live server-side — the flag says only "show the name
 * form", so there is nothing here worth forging: a parent who types it by hand
 * gets a form that fails on a cookie they do not have.
 */
export function isIdCheckReturn(search: string): boolean {
  return new URLSearchParams(search).get('idcheck') === 'return';
}

interface Draft {
  parentName: string;
  parentEmail: string;
  childFirstName: string;
  country: Country;
  band: Band | null;
  board: string;
  pin: string;
  pinConfirm: string;
  memoryOn: boolean;
  learnOn: boolean;
  visionOn: boolean;
  voiceOn: boolean;
}

const EMPTY: Draft = {
  parentName: '', parentEmail: '', childFirstName: '', country: 'IN',
  band: null, board: 'General', pin: '', pinConfirm: '',
  // Memory defaults ON; the other three are separate asks and default OFF.
  memoryOn: true, learnOn: false, visionOn: false, voiceOn: false,
};

export function Consent({ api, onDone }: { api: Api; onDone: () => void }): preact.JSX.Element {
  const [step, setStep] = useState(
    () => (typeof location !== 'undefined' && isIdCheckReturn(location.search))
      ? RETURN_STEP : 1);
  const [d, setD] = useState<Draft>(EMPTY);
  /**
   * The name as printed on the ID. Never persisted anywhere — it is compared
   * against the document in one request and forgotten. Held apart from `Draft`
   * so it cannot ride along into `api.draft()` and be stored.
   */
  const [idName, setIdName] = useState('');
  /** False once a refusal is terminal, so the parent is not asked to try again. */
  const [canRetry, setCanRetry] = useState(true);
  const [offers, setOffers] = useState<readonly MethodOffer[]>([]);
  const [method, setMethod] = useState<ConsentMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void =>
    setD((prev) => ({ ...prev, [k]: v }));

  // The rails on offer depend on the jurisdiction, so this reloads whenever the
  // country changes rather than being fetched once at mount.
  useEffect(() => {
    let live = true;
    api.methods(d.country)
      .then((r) => { if (live) { setOffers(r.offers); setMethod(r.methods[0] ?? null); } })
      .catch(() => { if (live) setOffers([]); });
    return () => { live = false; };
  }, [api, d.country]);

  const canAdvance = ((): boolean => {
    switch (step) {
      case 1: return d.parentName.trim() !== '' && /.+@.+\..+/.test(d.parentEmail);
      case 2: return d.childFirstName.trim() !== '';
      case 3: return true;
      case 4: return d.band !== null;
      case 5: return true;
      case 6: return d.pin.length >= 4 && d.pin === d.pinConfirm;
      case 7: return true;
      default: return false;
    }
  })();

  async function verify(): Promise<void> {
    if (method === null || d.band === null) return;
    setWorking(true);
    setError(null);
    try {
      const draft = await api.draft({
        parentName: d.parentName.trim(),
        parentEmail: d.parentEmail.trim(),
        childFirstName: d.childFirstName.trim(),
        country: d.country,
        band: d.band,
        board: d.board,
        memoryOn: d.memoryOn,
        learnOn: d.learnOn,
        visionOn: d.visionOn,
        voiceOn: d.voiceOn,
        method,
        pin: d.pin,
        pinConfirm: d.pinConfirm,
      });
      // A rail that hands off finishes somewhere else. Leave — the server has
      // already remembered which verification this is, so there is nothing for
      // us to carry across the navigation and nothing to put in localStorage.
      //
      // Branching on the FIELD rather than on the method name is deliberate: a
      // second hand-off rail needs no change here.
      if (draft.redirectUrl) {
        location.assign(draft.redirectUrl);
        return;
      }
      // The token never comes back to us — `finalize` sets an httpOnly cookie.
      // `onDone` re-asks the server what we now hold, which is the only way the
      // client can find out.
      await api.finalize(draft.consentId, draft.challengeId);
      onDone();
    } catch (e) {
      // A failed verification must not produce a consent, and must say so
      // plainly rather than leaving the parent on a spinner.
      setError(e instanceof ApiError ? e.message : 'Could not reach Chittu.');
    } finally {
      setWorking(false);
    }
  }

  /**
   * Finish the check the parent has come back from.
   *
   * Sends one thing: the name printed on the document. Everything that decides
   * anything — which verification this is, and whether it passed — is the
   * server's, and the verdict is fetched from the vendor rather than claimed
   * here.
   */
  async function submitIdName(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      await api.verifyId(idName.trim());
      onDone();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        // The server says whether another go could work. Believe it rather than
        // guessing from the message: a parent kept typing at a rail that has
        // already ended is a parent we are wasting.
        setCanRetry(e.retryable);
      } else {
        setError('Could not reach Chittu.');
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <main class="consent">
      <h1 class="consent__title">
        <span class="brand__bird" aria-hidden="true">🐦</span>
        Chittu <span class="brand__tam">சிட்டு</span>
      </h1>
      <p class="consent__sub">
        A grown-up sets this up. Chittu cannot talk to your child until you finish.
      </p>

      {/* The return step is not IN the sequence, so it borrows the last
          segment rather than announcing "Step 100 of 8" — the parent coming
          back from the ID check is at the end of the walk, not off the map. */}
      <ol class="stepper"
        aria-label={`Step ${step === RETURN_STEP ? TOTAL_STEPS : step} of ${TOTAL_STEPS}`}>
        {/* Eight segments, because eight is what it announces. Seven beside a
            spoken "of 8" is the same bug wearing a different hat. The fill rule
            is unchanged — `i < step` fills the step you are ON as well as the
            ones behind it — so the bar is full on the gate rather than a
            segment short of it. */}
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <li key={i} class={i < (step === RETURN_STEP ? TOTAL_STEPS : step) ? 'is-done' : ''} />
        ))}
      </ol>

      <section class="card">
        {step === 1 && (
          <>
            <h2>Who are you?</h2>
            <p class="sub">We keep your name and email to prove consent was given, and for nothing else.</p>
            <Field label="Your name" id="pname">
              <input id="pname" type="text" autocomplete="name" value={d.parentName}
                onInput={(e) => set('parentName', (e.currentTarget as HTMLInputElement).value)} />
            </Field>
            <Field label="Your email" id="pmail">
              <input id="pmail" type="email" autocomplete="email" value={d.parentEmail}
                onInput={(e) => set('parentEmail', (e.currentTarget as HTMLInputElement).value)} />
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Your child's first name</h2>
            <p class="sub">
              First name only. There is nowhere in our database to put a surname, which is
              deliberate — the less we hold, the less there is to lose.
            </p>
            <Field label="First name" id="cname">
              <input id="cname" type="text" autocomplete="off" maxLength={40}
                value={d.childFirstName}
                onInput={(e) => set('childFirstName', (e.currentTarget as HTMLInputElement).value)} />
            </Field>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Where are you?</h2>
            <p class="sub">This decides which law applies and which crisis helplines Chittu can give.</p>
            <Field label="Country" id="country">
              <select id="country" value={d.country}
                onChange={(e) => set('country', (e.currentTarget as HTMLSelectElement).value as Country)}>
                {COUNTRIES.map((c) => <option key={c} value={c}>{COUNTRY_NAMES[c]}</option>)}
              </select>
            </Field>
          </>
        )}

        {step === 4 && (
          <>
            <h2>How old is your child?</h2>
            <p class="sub">This changes how Chittu talks — sentence length, vocabulary, and what it will discuss at all.</p>
            <div class="options options--3">
              {BAND_INFO.map((b) => (
                <button key={b.id} type="button"
                  class={`option${d.band === b.id ? ' is-selected' : ''}`}
                  aria-pressed={d.band === b.id}
                  onClick={() => set('band', b.id)}>
                  {b.label}<small>{b.ages}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h2>Which curriculum?</h2>
            <p class="sub">Used by Explain, Homework and Maths. Skip it if none fits.</p>
            <Field label="Curriculum" id="board">
              <select id="board" value={d.board}
                onChange={(e) => set('board', (e.currentTarget as HTMLSelectElement).value)}>
                <option value="General">General (no specific board)</option>
                {BOARD_GROUPS.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.boards.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
          </>
        )}

        {step === 6 && (
          <>
            <h2>Choose a parent PIN</h2>
            <p class="sub">
              It unlocks the parent dashboard and is the only way to lift a crisis pause.
              It is checked on our server, never in the browser — a curious eleven-year-old
              can read anything the browser knows.
            </p>
            <Field label="PIN (4–6 digits)" id="pin">
              <input id="pin" type="password" inputMode="numeric" autocomplete="new-password"
                minLength={4} maxLength={6} value={d.pin}
                onInput={(e) => set('pin', (e.currentTarget as HTMLInputElement).value)} />
            </Field>
            <Field label="Type it again" id="pin2">
              <input id="pin2" type="password" inputMode="numeric" autocomplete="new-password"
                minLength={4} maxLength={6} value={d.pinConfirm}
                onInput={(e) => set('pinConfirm', (e.currentTarget as HTMLInputElement).value)} />
            </Field>
            {d.pinConfirm !== '' && d.pin !== d.pinConfirm && (
              <p class="field__error">Those don't match yet.</p>
            )}
          </>
        )}

        {step === 7 && (
          <>
            <h2>Four choices, all yours</h2>
            <Toggle
              on={d.memoryOn}
              onChange={(v) => set('memoryOn', v)}
              title="Let Chittu remember nice things"
              body="Only interests, pets, hobbies, favourites, achievements and things learned. Never feelings, health, family matters or fears. You see the whole list and can delete any of it."
            />
            <Toggle
              on={d.learnOn}
              onChange={(v) => set('learnOn', v)}
              title="Help improve Chittu"
              body="Off unless you turn it on. Raw chats never train models. If you turn this on, a person reviews an anonymised summary first."
            />
            <Toggle
              on={d.visionOn}
              onChange={(v) => set('visionOn', v)}
              title="Let your child show Chittu a picture"
              body="Off unless you turn it on. A photo is sent to be described, then discarded — we never store pictures, and Chittu never identifies people, guesses ages or comments on how anyone looks."
            />
            <Toggle
              on={d.voiceOn}
              onChange={(v) => set('voiceOn', v)}
              title="Let your child talk to Chittu"
              body="Off unless you turn it on. Your child's device turns speech into text and throws the sound away — the recording never leaves the device and we never receive it. This also switches on reading aloud. Chittu can still read its answers out loud either way."
            />
          </>
        )}

        {step > STEPS && step !== RETURN_STEP && (
          <>
            <h2>Prove you're the grown-up</h2>
            <p class="sub">
              This is the law's requirement, not ours. We keep a reference and a hash —
              never your document, card number or ID image.
            </p>
            {offers.length === 0 && (
              <p class="field__error">
                No verification method is available for {COUNTRY_NAMES[d.country]} yet.
              </p>
            )}
            <div class="options">
              {offers.map((o) => (
                <button key={o.method} type="button"
                  class={`option option--wide${method === o.method ? ' is-selected' : ''}`}
                  aria-pressed={method === o.method}
                  disabled={!o.available}
                  onClick={() => setMethod(o.method)}>
                  {METHOD_LABELS[o.method] ?? o.method}
                  {!o.available && <small>Not available yet — {o.blockedOn}</small>}
                </button>
              ))}
            </div>
            {error !== null && <p class="field__error" role="alert">{error}</p>}
          </>
        )}

        {step === RETURN_STEP && (
          <>
            <h2>One last thing</h2>
            <p class="sub">
              Type your name exactly as it is printed on the ID you just showed. We compare
              it once and forget it — it is never stored, and we never see the document.
            </p>
            <Field label="Name as printed on your ID" id="idname">
              <input id="idname" type="text" autocomplete="off" maxLength={120}
                value={idName} disabled={!canRetry}
                onInput={(e) => setIdName((e.currentTarget as HTMLInputElement).value)} />
            </Field>
            {error !== null && <p class="field__error" role="alert">{error}</p>}
            {!canRetry && (
              <p class="sub">
                This check cannot go any further. You can start again and choose another
                way to verify.
              </p>
            )}
          </>
        )}

        <div class="card__actions">
          {step > 1 && step !== RETURN_STEP && (
            <button type="button" class="btn btn--secondary" disabled={working}
              onClick={() => { setError(null); setStep(step - 1); }}>
              Back
            </button>
          )}
          {step === RETURN_STEP ? (
            canRetry ? (
              <button type="button" class="btn"
                disabled={working || idName.trim() === ''}
                onClick={() => { void submitIdName(); }}>
                {working ? 'Checking…' : 'Finish'}
              </button>
            ) : (
              <button type="button" class="btn"
                onClick={() => {
                  // Back to a clean form on a URL with no return flag, so a
                  // reload does not drop the parent straight back here.
                  location.assign(location.pathname);
                }}>
                Start again
              </button>
            )
          ) : step <= STEPS ? (
            <button type="button" class="btn" disabled={!canAdvance}
              onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button type="button" class="btn" disabled={method === null || working}
              onClick={() => { void verify(); }}>
              {working ? 'Verifying…' : 'Verify and finish'}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

function Field(
  { label, id, children }: { label: string; id: string; children: preact.ComponentChildren },
): preact.JSX.Element {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
    </div>
  );
}

function Toggle(
  { on, onChange, title, body }:
  { on: boolean; onChange: (v: boolean) => void; title: string; body: string },
): preact.JSX.Element {
  return (
    <button type="button" class="toggle" role="switch" aria-checked={on}
      onClick={() => onChange(!on)}>
      <span class="toggle__text"><b>{title}</b>{body}</span>
      <span class={`toggle__switch${on ? ' is-on' : ''}`} aria-hidden="true" />
    </button>
  );
}
