/**
 * Session state. A dozen fields, so a dozen signals.
 *
 * **Deviation from architecture §2.1, recorded on purpose.** The document
 * specifies Zustand. Zustand imports `react`, which on Preact means aliasing
 * `preact/compat` into the bundle — and compat exists precisely so we can reach
 * for React libraries *when we need to*, against a 100 KB budget whose whole
 * justification was not shipping React. `@preact/signals` is ~1 KB, native, and
 * covers what a dozen fields need. TanStack Query is likewise absent: there are
 * three server interactions, one of which (a child's memory list) must never be
 * served stale from a cache.
 *
 * Nothing safety-relevant lives here. Band, country and board are read back from
 * the session the server opened against a sealed consent record; the client
 * cannot assert them, and this store has nowhere to put them if it tried.
 */

import { signal, computed } from '@preact/signals';
import type { Band, Block, Country, Flag, Memory, Mode, PipelineLayer } from '@chittu/contracts';
import type { SessionResponse } from './api';

export type Message =
  | { readonly id: string; readonly role: 'child'; readonly text: string }
  | {
      readonly id: string; readonly role: 'chittu';
      readonly blocks: readonly Block[];
      readonly trace: string;
      readonly layers: readonly PipelineLayer[];
    }
  /** Our own UI copy — an error, a lockout notice. Never a safety script. */
  | { readonly id: string; readonly role: 'system'; readonly text: string }
  | { readonly id: string; readonly role: 'memory'; readonly memory: Memory }
  /**
   * The reading coach's passage card. `hit` is null until the SERVER scored
   * the attempt — the marks always arrive from the API, never from a local
   * judgement, because the client renders and decides nothing.
   */
  | {
      readonly id: string; readonly role: 'readcard';
      readonly words: readonly { readonly word: string; readonly hit: boolean | null }[];
    }
  /** The scripted score line ("🌟 7 of 8 words — great reading!"), server-authored. */
  | { readonly id: string; readonly role: 'readscore'; readonly text: string };

/**
 * **This client stores no credential, because it holds none.**
 *
 * The consent token lives in an httpOnly cookie the server set at `finalize`.
 * JavaScript cannot read it, which is the point: it is a bearer credential, and
 * anything that could read it — an injected script, a compromised dependency,
 * an eleven-year-old in devtools — could open a session as this child. It used
 * to sit in `localStorage`.
 *
 * The consequence is that the client can no longer answer "am I signed in?"
 * from memory. It has to ask, and the answer is authoritative rather than
 * inferred. Hence three states rather than a boolean: until the server replies
 * we do not know, and **"do not know" must never render the chat**.
 */
export type ConsentState = 'unknown' | 'none' | 'active';

export const consentState = signal<ConsentState>('unknown');

/** From the sealed record, via `/v1/consent/status`. Never asserted by us. */
export interface Profile {
  readonly band: Band;
  readonly country: Country;
  readonly childFirstName: string;
}

export const profile = signal<Profile | null>(null);

/** True only when the SERVER said so. Default-deny while `unknown`. */
export const hasConsent = computed(() => consentState.value === 'active');

export function forgetConsent(): void {
  consentState.value = 'none';
  profile.value = null;
  session.value = null;
  messages.value = [];
  memories.value = [];
  crisisLock.value = false;
  flags.value = [];
}

export const session = signal<SessionResponse | null>(null);
export const messages = signal<readonly Message[]>([]);
export const memories = signal<readonly Memory[]>([]);
export const flags = signal<readonly Flag[]>([]);
export const mode = signal<Mode>('chat');
export const crisisLock = signal(false);
export const busy = signal(false);

export function push(m: Message): void {
  messages.value = [...messages.value, m];
}

let seq = 0;
export const nextId = (): string => `m${++seq}`;

/**
 * Lite mode: no animation, no TTS prefetch (§4.1). Default ON for a slow radio
 * or a small device, because the device floor is a ₹8,000 Android and the
 * comfortable case should be the one that opts in.
 *
 * Both signals are non-standard and absent in Safari and Firefox, so the checks
 * are defensive and the default when nothing is known is "not lite" — guessing
 * lite on a capable device would degrade an experience for no reason.
 */
export function detectLite(nav: Navigator = globalThis.navigator): boolean {
  const conn = (nav as { connection?: { effectiveType?: string } }).connection;
  const slow = conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g';
  const small = ((nav as { deviceMemory?: number }).deviceMemory ?? Infinity) <= 2;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return slow || small || reduced;
}

export const lite = signal(false);

/**
 * Speech recognition is Chrome/Edge-prefixed, absent in Firefox, and unreliable
 * in Safari (§4.3). The rule is: hide the mic where it is unavailable and say so,
 * rather than showing a button that does nothing.
 */
export function speechRecognitionAvailable(w: typeof globalThis = globalThis): boolean {
  const g = w as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return g.SpeechRecognition !== undefined || g.webkitSpeechRecognition !== undefined;
}

export function speechSynthesisAvailable(w: typeof globalThis = globalThis): boolean {
  return (w as { speechSynthesis?: unknown }).speechSynthesis !== undefined;
}
