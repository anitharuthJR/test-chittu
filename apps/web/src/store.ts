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
import type { Block, Flag, Memory, Mode, PipelineLayer } from '@chittu/contracts';
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
  | { readonly id: string; readonly role: 'memory'; readonly memory: Memory };

const TOKEN_KEY = 'chittu.consentToken';
const ID_KEY = 'chittu.consentId';

/**
 * localStorage, and it should not stay that way.
 *
 * The consent token is a bearer credential: whoever holds it can open a session
 * as this child. It belongs in an httpOnly cookie the server sets at
 * `/finalize`, which the API does not do yet — see PORT-REVIEW §11. What it
 * does NOT unlock is the parent surface (PIN is verified server-side) or
 * another family's data (row-level security), so the exposure is bounded to a
 * shared device rather than to the network.
 */
function readStored(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

function writeStored(key: string, v: string | null): void {
  try {
    if (v === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, v);
  } catch { /* private mode, quota, disabled — the app still works, just not across reloads */ }
}

export const consentToken = signal<string | null>(readStored(TOKEN_KEY));
export const consentId = signal<string | null>(readStored(ID_KEY));

export function rememberConsent(id: string, token: string): void {
  consentId.value = id;
  consentToken.value = token;
  writeStored(ID_KEY, id);
  writeStored(TOKEN_KEY, token);
}

export function forgetConsent(): void {
  consentId.value = null;
  consentToken.value = null;
  writeStored(ID_KEY, null);
  writeStored(TOKEN_KEY, null);
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

/** Law 02, as a boolean the router reads. There is no other way into the chat. */
export const hasConsent = computed(() => consentToken.value !== null);

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
