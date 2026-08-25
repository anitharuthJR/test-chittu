/**
 * The scripted welcome — D1/H, "Scripted welcome + one warm memory if any".
 *
 * Ported from prototype/chittu-v3.html lines 864-871, where the opening line is
 * traced `SPINE · welcome` and gains `+ MEMORY` when it carries one. Two
 * DELIBERATE deviations from that reference, both recorded in PORT-REVIEW.md:
 *
 *   - **The memory is the most recent, not a random one.** The prototype picks
 *     with `Math.random()`. The kernel has no randomness by construction (it is
 *     a pure-function package, and that is what makes it reviewable), and "the
 *     thing you told me last time" is the warmer choice anyway.
 *   - **The words are the API-era welcome's**, not the prototype's `let's
 *     play!`, which was written for a four-year-old and shipped to every band.
 *     The plain line below is the one the client has been rendering since the
 *     port; only the memory clause is new.
 *
 * Separate from `spines.ts` on purpose: a spine is a GUARD's reply, keyed by
 * `GuardKind`. This is a session opener, and it carries an allowlist decision
 * rather than only copy.
 */

import type { Memory } from '@chittu/contracts';
import { MEMORY_CATEGORIES } from '@chittu/contracts';

/**
 * `{M}` is the memory slot, exactly as `{L}` is the helpline slot in
 * `CRISIS_MAIN`. Scripted safety copy — reword nothing; a model must never be
 * asked to produce, paraphrase or "improve" it.
 */
export const WELCOME: { readonly plain: string; readonly withMemory: string } = Object.freeze({
  plain: "Hello! I'm Chittu. Ask me anything, or pick something below.",
  withMemory:
    "Hello! I'm Chittu. You're back — I remember: {M}. Ask me anything, or pick something below.",
});

/**
 * The one memory allowed to open a conversation, or null.
 *
 * **This is the same allowlist that governs `memAdd`, applied a second time at
 * the READ side**, and the duplication is the point. `memAdd` decides what may
 * be written; this decides what may be spoken back unprompted, months later, to
 * a child who has forgotten saying it. A row can reach here without passing
 * through `memAdd` today — a category retired from the list, a hand-edited
 * database, a future writer that is not `memAdd` — and the failure mode of
 * trusting the row is Chittu opening a session with a child's fear.
 *
 * Never memories from feelings, health, family matters, fears, or crisis
 * moments: the allowlist is closed, so those are excluded by not being on it.
 */
export function welcomeMemory(memories: readonly Memory[]): Memory | null {
  let best: Memory | null = null;
  for (const m of memories) {
    if (!(MEMORY_CATEGORIES as readonly string[]).includes(m.category)) continue;
    if (typeof m.fact !== 'string' || m.fact.trim() === '') continue;
    if (best === null || m.since >= best.since) best = m;
  }
  return best;
}

/**
 * The welcome line, with the memory folded in when there is one.
 *
 * The fact is stored text a model wrote, so two things are handled here that
 * look like fussiness and are not:
 *
 *   - The replacement is a FUNCTION. `String.replace` expands `$&`, `` $` ``
 *     and `$'` inside a string replacement, and this replacement is not ours.
 *   - A trailing full stop is dropped, because the sentence supplies its own
 *     and `Mani..` is what a child would see otherwise.
 *
 * It emits no block markup. The caller puts the result in a `text` block
 * directly rather than through `parseBlocks`, so a fact carrying `[CHIPS]…` is
 * prose rather than buttons.
 */
export function welcomeSpine(memory: Memory | null): string {
  if (memory === null) return WELCOME.plain;
  const fact = memory.fact.trim().replace(/\.$/, '');
  if (fact === '') return WELCOME.plain;
  return WELCOME.withMemory.replace('{M}', () => fact);
}
