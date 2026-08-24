import type { PipelineLayer } from '@chittu/contracts';

/**
 * Which layers actually ran, in the order they ran.
 *
 * This is the audit trail made visible, and it is shown by default rather than
 * hidden behind a developer flag: a parent being able to see that L1 fired is
 * part of what makes the claim checkable rather than a marketing line. The
 * server sends `layers` on every turn; the client only formats them.
 */
export function TraceStrip(
  { trace, layers }: { trace: string; layers: readonly PipelineLayer[] },
): preact.JSX.Element | null {
  if (trace === '' && layers.length === 0) return null;
  return (
    <p class="trace">
      ↳ <b>{trace}</b>
      {layers.length > 0 && <span class="trace__layers"> · {layers.join(' → ')}</span>}
    </p>
  );
}
