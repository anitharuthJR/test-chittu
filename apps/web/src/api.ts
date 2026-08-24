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

/**
 * No token. It went into an httpOnly cookie, which is the whole point — a
 * credential in a response body is readable by every script on the page and by
 * anything that logs a response.
 */
export interface FinalizeResponse {
  readonly ledger: Readonly<Record<string, unknown>>;
}

/** The only way the client can learn whether it holds a usable consent. */
export type StatusResponse =
  | { readonly active: false }
  | {
      readonly active: true;
      readonly band: Band;
      readonly country: Country;
      readonly childFirstName: string;
    };

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
 * A flag as a parent sees it: a category and wording written by us, plus — for
 * ASSIST only — a bare school topic. There is deliberately no field here that
 * could hold what a child typed, which mirrors the table having no column for
 * it.
 */
export interface ParentFlag {
  readonly kind: 'SAFETY' | 'ASSIST' | 'GATE';
  readonly category: string;
  readonly body: string;
  readonly at: string;
  readonly topic: string | null;
}

export interface SessionSummary {
  readonly id: string;
  readonly band: Band;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly msgCount: number;
  readonly crisisLock: boolean;
}

export interface DashboardResponse {
  readonly child: {
    readonly firstName: string; readonly band: Band;
    readonly country: Country; readonly board: string;
  };
  readonly consent: {
    readonly law: string; readonly method: string; readonly status: string;
    readonly issuedAt: string | null; readonly expiresAt: string | null;
    readonly scopes: { readonly memory: boolean; readonly learning: boolean };
  };
  readonly stats: {
    readonly sessions: number; readonly messages: number;
    readonly spines: number; readonly memories: number;
    readonly crisisLocked: boolean;
    readonly firstSeen: string | null; readonly lastSeen: string | null;
  };
  readonly sessions: readonly SessionSummary[];
  readonly memories: readonly Memory[];
  readonly flags: {
    readonly safety: readonly ParentFlag[];
    readonly assist: readonly ParentFlag[];
    readonly gate: readonly ParentFlag[];
  };
  readonly helplines: {
    readonly name: string; readonly law: string; readonly consent: string;
    readonly lines: readonly { readonly name: string; readonly contact: string }[];
  };
  readonly learning: {
    readonly optedIn: boolean;
    /** Always false. The loop has no link back to a child, by design. */
    readonly perChildQueueExists: boolean;
  };
}

export interface TranscriptResponse {
  readonly band: Band;
  /** False for a teen — and the UI must say so rather than showing a blank. */
  readonly bodiesIncluded: boolean;
  readonly note: string | null;
  readonly turns: readonly {
    readonly seq: number; readonly role: string;
    readonly topic: string | null; readonly body: string | null;
  }[];
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
      // The consent and parent cookies are httpOnly, so this is the ONLY way
      // credentials reach the server — there is nothing for us to attach by
      // hand. Same-origin because the dev proxy and production both put the API
      // behind the same host; a cross-origin API would need `include` here and
      // a CORS policy with `credentials: true` there, and neither exists.
      credentials: 'same-origin',
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

    /** Sets the consent cookie on success. Returns no credential. */
    finalize: (consentId: string, challengeId: string, proof?: unknown) =>
      go<FinalizeResponse>(
        `/v1/consent/${consentId}/finalize`,
        json(proof === undefined ? { challengeId } : { challengeId, proof })),

    status: () => go<StatusResponse>('/v1/consent/status'),

    // ---- parent -----------------------------------------------------------
    // No consent id in any of these paths: the server reads the cookie. The
    // client used to hold an id, and an id was all it took to erase an account.

    /** On success the server issues a 15-minute parent-session cookie. */
    verifyPin: (pin: string) => go<PinResponse>('/v1/parent/pin/verify', json({ pin })),

    signOutParent: () => go<{ ok: boolean }>('/v1/parent/signout', { method: 'POST' }),

    /** Requires a live parent session. 403 `PARENT_REQUIRED` without one. */
    dashboard: () => go<DashboardResponse>('/v1/parent/dashboard'),

    /** Band-aware: a teen's turns come back with `body: null` and a note. */
    transcript: (sessionId: string) =>
      go<TranscriptResponse>(`/v1/parent/sessions/${sessionId}/transcript`),

    /** No cookie needed — a child in trouble must not wait for an adult. */
    helplines: (country: Country) =>
      go<{ country: Country; name: string; lines: readonly { name: string; contact: string }[] }>(
        `/v1/helplines/${country}`),

    /** Requires a live parent session. 403 `PARENT_REQUIRED` without one. */
    revoke: () => go<RevokeResponse>('/v1/consent', { method: 'DELETE' }),

    // ---- session ----------------------------------------------------------

    openSession: (mode?: Mode) =>
      go<SessionResponse>('/v1/session', json(mode === undefined ? {} : { mode })),

    /** Buffered, never streamed — L6 matches phrases (§4.2). */
    turn: (sessionId: string, text: string, mode?: Mode) =>
      go<TurnResponse>(`/v1/session/${sessionId}/turn`,
        json(mode === undefined ? { text } : { text, mode })),

    seal: (sessionId: string) => go<SealResponse>(`/v1/session/${sessionId}/seal`),

    memories: (sessionId: string) =>
      go<{ memories: readonly Memory[] }>(`/v1/session/${sessionId}/memories`),

    /**
     * Who deleted it is decided by the server from the parent cookie, not
     * declared here. `deleted_by` is audit data, and a caller that can name
     * itself is not evidence of anything.
     */
    forget: (sessionId: string, memoryId: string) =>
      go<{ forgotten: boolean }>(
        `/v1/session/${sessionId}/memories/${memoryId}`, { method: 'DELETE' }),

    /** The only unlock path in the system. Parent action, PIN-gated in the UI. */
    ackCrisis: (sessionId: string) =>
      go<{ crisisLock: boolean }>(`/v1/session/${sessionId}/crisis/ack`, { method: 'POST' }),
  };
}

export type Api = ReturnType<typeof createApi>;
