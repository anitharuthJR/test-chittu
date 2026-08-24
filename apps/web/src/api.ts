/**
 * Everything the client is allowed to ask the server for.
 *
 * Two rules shape this file.
 *
 * **It imports only `@chittu/contracts`.** Not `@chittu/consent`, which would
 * drag `node:crypto` into a browser bundle; not `@chittu/safety-kernel`, which
 * would publish `L1_PATTERNS` to anyone who opens devtools. The consent method
 * union is therefore restated here as a narrow string union rather than
 * imported, and `methods.test.ts` pins it against the server's own list.
 *
 * **Nothing here decides anything.** Band, country and board come back from the
 * sealed consent record; the client never asserts them. If a call looks like it
 * lets the client choose something safety-relevant, that is a bug in the call.
 */

import type { Block, Band, Country, Flag, Memory, Mode, PipelineLayer } from '@chittu/contracts';

/** Mirrors `ConsentMethod` in @chittu/consent. Pinned by a test, not by trust. */
export type ConsentMethod =
  | 'dev_stub' | 'card_micro_charge' | 'email_plus' | 'signed_form_review'
  | 'gov_id_review' | 'consent_manager_token' | 'digilocker' | 'age_assurance_uk';

export interface MethodOffer {
  readonly method: ConsentMethod;
  readonly available: boolean;
  readonly blockedOn?: string;
}

export interface MethodsResponse {
  readonly country: Country;
  readonly methods: readonly ConsentMethod[];
  readonly offers: readonly MethodOffer[];
}

export interface DraftRequest {
  readonly parentName: string;
  readonly parentEmail: string;
  readonly childFirstName: string;
  readonly country: Country;
  readonly band: Band;
  readonly board?: string;
  readonly memoryOn?: boolean;
  readonly learnOn?: boolean;
  readonly method: ConsentMethod;
  readonly pin: string;
  readonly pinConfirm: string;
}

export interface DraftResponse {
  readonly consentId: string;
  readonly challengeId: string;
  readonly instructions: string;
  readonly law: string;
  readonly status: string;
}

export interface FinalizeResponse {
  readonly consentToken: string;
  readonly ledger: Readonly<Record<string, unknown>>;
}

export interface SessionResponse {
  readonly sessionId: string;
  readonly band: Band;
  readonly country: Country;
}

export interface TurnResponse {
  readonly blocks: readonly Block[];
  readonly trace: string;
  readonly layers: readonly PipelineLayer[];
  readonly crisisLock: boolean;
  readonly flags: readonly Flag[];
  readonly memorySaved?: Memory;
}

export interface SealResponse {
  readonly ok: boolean;
  readonly records: number;
  readonly brokenAt: number | null;
}

export interface PinResponse {
  readonly ok: boolean;
  readonly locked: boolean;
  readonly note?: string;
}

export interface RevokeResponse {
  readonly status: string;
  readonly sessionsEnded: number;
}

/**
 * A failed call, with the server's own message where it is safe to show.
 *
 * The API replaces every 5xx body with `{"error":"something went wrong"}` so a
 * stack trace cannot become something a child reads. That means `message` is
 * always server-authored text and never an exception from inside our process.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the network never reached the API at all — offline, DNS, CORS. */
export class OfflineError extends Error {
  constructor() {
    super('Could not reach Chittu.');
    this.name = 'OfflineError';
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { readonly fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const { fetchImpl = globalThis.fetch, ...rest } = init;
  let res: Response;
  try {
    res = await fetchImpl(path, {
      ...rest,
      headers: rest.body !== undefined
        ? { 'content-type': 'application/json', ...rest.headers }
        : rest.headers ?? {},
    });
  } catch {
    throw new OfflineError();
  }

  if (res.status === 204) return undefined as T;

  let body: unknown;
  try { body = await res.json(); }
  catch {
    if (res.ok) throw new ApiError(res.status, 'The server sent something unreadable.');
    throw new ApiError(res.status, 'Something went wrong.');
  }

  if (!res.ok) {
    const e = body as { error?: string; code?: string };
    throw new ApiError(res.status, e.error ?? 'Something went wrong.', e.code);
  }
  return body as T;
}

const json = (b: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(b) });

/**
 * @param fetchImpl injected so tests drive real code against a stub rather than
 *   mocking the module. Every method threads it through.
 */
export function createApi(base = '', fetchImpl: typeof fetch = globalThis.fetch) {
  const at = (p: string) => `${base}${p}`;
  const go = <T>(p: string, init: RequestInit = {}) =>
    call<T>(at(p), { ...init, fetchImpl });

  return {
    health: () => go<{ status: string }>('/health'),

    // ---- consent (Law 02: nothing below /session exists before this) -------

    methods: (country: Country) =>
      go<MethodsResponse>(`/v1/consent/methods?country=${encodeURIComponent(country)}`),

    draft: (body: DraftRequest) => go<DraftResponse>('/v1/consent/draft', json(body)),

    finalize: (consentId: string, challengeId: string, proof?: unknown) =>
      go<FinalizeResponse>(
        `/v1/consent/${consentId}/finalize`,
        json(proof === undefined ? { challengeId } : { challengeId, proof })),

    verifyPin: (consentId: string, pin: string) =>
      go<PinResponse>(`/v1/consent/${consentId}/pin/verify`, json({ pin })),

    revoke: (consentId: string) =>
      go<RevokeResponse>(`/v1/consent/${consentId}`, { method: 'DELETE' }),

    // ---- session ----------------------------------------------------------

    openSession: (consentToken: string, mode?: Mode) =>
      go<SessionResponse>('/v1/session',
        json(mode === undefined ? { consentToken } : { consentToken, mode })),

    /** Buffered, never streamed — L6 matches phrases (§4.2). */
    turn: (sessionId: string, text: string, mode?: Mode) =>
      go<TurnResponse>(`/v1/session/${sessionId}/turn`,
        json(mode === undefined ? { text } : { text, mode })),

    seal: (sessionId: string) => go<SealResponse>(`/v1/session/${sessionId}/seal`),

    memories: (sessionId: string) =>
      go<{ memories: readonly Memory[] }>(`/v1/session/${sessionId}/memories`),

    forget: (sessionId: string, memoryId: string, by: 'child' | 'parent') =>
      go<{ forgotten: boolean }>(
        `/v1/session/${sessionId}/memories/${memoryId}?by=${by}`, { method: 'DELETE' }),

    /** The only unlock path in the system. Parent action, PIN-gated in the UI. */
    ackCrisis: (sessionId: string) =>
      go<{ crisisLock: boolean }>(`/v1/session/${sessionId}/crisis/ack`, { method: 'POST' }),
  };
}

export type Api = ReturnType<typeof createApi>;
