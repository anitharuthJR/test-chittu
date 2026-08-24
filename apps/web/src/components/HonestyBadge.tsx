/**
 * Law 03, the honest machine. Persistent and NOT dismissible (§4, A4).
 *
 * There is deliberately no `onDismiss`, no `hidden` prop and no timer. A child
 * who has stopped noticing it has still been told, and a child who asks "are
 * you real?" gets a scripted answer from the server as well — this is the
 * ambient half of the same promise.
 */
export function HonestyBadge(): preact.JSX.Element {
  return (
    <p class="honesty" role="note">
      I'm a computer program — not a person.
    </p>
  );
}
