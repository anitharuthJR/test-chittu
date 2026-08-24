import type { Mode } from '@chittu/contracts';
import { MODES } from '../catalog';

/**
 * Eleven surfaces. A horizontal scroller on a phone, a left rail from 900px
 * (§4.3) — both from the same markup, decided in CSS, because a device query
 * would call a 507px iPad split view a phone.
 */
export function ModeBar(
  { current, onPick, disabled }:
  { current: Mode; onPick: (m: Mode) => void; disabled?: boolean },
): preact.JSX.Element {
  return (
    <nav class="modebar" aria-label="What shall we do?">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          class={`modebar__btn${m.id === current ? ' is-on' : ''}`}
          aria-current={m.id === current ? 'true' : undefined}
          disabled={disabled ?? false}
          onClick={() => onPick(m.id)}
        >
          {m.label}
        </button>
      ))}
    </nav>
  );
}
