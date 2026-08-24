/**
 * Shown while a session is crisis-locked.
 *
 * Two things this panel must not do, both of which were easy mistakes to make:
 *
 * It does not quote the child. Nothing here says what was typed, because the
 * parent flag itself stores only a category and this surface must not be a way
 * around that.
 *
 * It does not offer to unlock. The unlock is a parent action behind the PIN
 * (§4.5, `POST /crisis/ack`), so the only route from here is the parent gate.
 * A child tapping "I'm fine now" would defeat the entire mechanism.
 */
export function CrisisPanel(
  { onParentGate }: { onParentGate: () => void },
): preact.JSX.Element {
  return (
    <section class="crisis" role="alert" aria-live="assertive">
      <h2 class="crisis__title">Let's pause and find a grown-up</h2>
      <p>
        Some things are too big for a computer program, and this is one of them.
        Please tell someone you trust — a parent, a teacher, or someone at home.
      </p>
      <p class="crisis__note">
        Chatting is paused until a grown-up unlocks it. That is on purpose.
      </p>
      <button type="button" class="btn btn--coral" onClick={onParentGate}>
        I'm a grown-up — unlock
      </button>
    </section>
  );
}
