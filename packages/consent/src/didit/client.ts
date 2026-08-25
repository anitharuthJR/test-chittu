/**
 * The Didit HTTP client, and the PII firewall.
 *
 * Didit's decision endpoint returns everything it learned about the parent:
 * `full_name`, `date_of_birth`, `document_number`, `mrz`, `nationality`,
 * `gender`, `address`, `place_of_birth`, face-match and liveness scores, and
 * presigned URLs to the document images and a portrait. The consent port's
 * contract is the opposite — a REFERENCE and a HASH, never the evidence — so
 * the boundary between those two facts has to live somewhere concrete.
 *
 * It lives here. `fetchDecision` parses the response and returns THREE things:
 * a status, a boolean, and the name. The raw object never leaves this module,
 * so no caller can log it, store it, or decide to keep "just the document
 * number" later without editing this file and being asked why.
 *
 * `isAdult` is computed here rather than returned as a date for the same
 * reason: a date of birth that never crosses the boundary cannot be leaked by
 * the code on the other side of it.
 *
 * The image URLs are never fetched. There is no code path in this package that
 * requests them, and `client.test.ts` asserts the only outbound calls are the
 * two endpoints below.
 */

export const DIDIT_BASE_URL = 'https://verification.didit.me';

/**
 * Every status Didit documents. Anything outside this set is NOT treated as a
 * recognised value — see `parseStatus`.
 */
export const DIDIT_STATUSES = [
  'Not Started', 'In Progress', 'Awaiting User', 'In Review',
  'Approved', 'Declined', 'Resubmitted', 'Expired', 'Kyc Expired', 'Abandoned',
] as const;

export type DiditStatus = (typeof DIDIT_STATUSES)[number];

export interface DiditConfig {
  readonly apiKey: string;
  readonly workflowId: string;
  /** Overridable so tests never touch the network. */
  readonly baseUrl?: string;
  /** Where Didit returns the parent when the hosted flow ends. */
  readonly callbackUrl?: string;
  /** Live credentials or sandbox ones. Guarded at boot; see resolveDiditConfig. */
  readonly environment?: 'live' | 'sandbox';
  readonly timeoutMs?: number;
}

export interface DiditSession {
  readonly sessionId: string;
  /** Didit-hosted capture page. The parent goes here; we never proxy it. */
  readonly url: string;
}

/**
 * All the adapter is allowed to know. Note what is absent: no date of birth, no
 * document number, no images, no scores.
 */
export interface DiditOutcome {
  readonly status: DiditStatus;
  readonly isAdult: boolean;
  /** Compared in memory and discarded. Never stored, never hashed, never logged. */
  readonly documentName: string;
}

export class DiditTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DiditTransportError';
  }
}

/**
 * Never invent a status we do not recognise.
 *
 * Same rule as `parseClassifier`: an unrecognised value is an unknown, and an
 * unknown must not become the permissive answer. A future Didit status string
 * lands here as `null` and the adapter refuses, rather than falling through
 * some `!== 'Declined'` test into minting a consent.
 */
export function parseStatus(raw: unknown): DiditStatus | null {
  return typeof raw === 'string' && (DIDIT_STATUSES as readonly string[]).includes(raw)
    ? raw as DiditStatus
    : null;
}

/**
 * 18+ from whatever the payload offers, without letting either field escape.
 *
 * `age` is preferred because it is Didit's own reading of the document. The
 * date of birth is the fallback, computed calendar-correctly rather than by
 * dividing milliseconds — leap years make the naive version wrong for people
 * born on the boundary, which is precisely the population this decides.
 */
export function derivedIsAdult(
  age: unknown, dateOfBirth: unknown, now: Date = new Date(),
): boolean {
  if (typeof age === 'number' && Number.isFinite(age)) return age >= 18;
  if (typeof dateOfBirth !== 'string') return false;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return false;
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) years--;
  return years >= 18;
}

type Fetcher = typeof fetch;

function headers(cfg: DiditConfig): Record<string, string> {
  return { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' };
}

async function call(
  f: Fetcher, url: string, init: RequestInit, timeoutMs: number,
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await f(url, { ...init, signal: ac.signal });
  } catch (e) {
    // A network failure is not a verdict. Retryable, and never approved.
    throw new DiditTransportError(
      `didit unreachable: ${e instanceof Error ? e.message : 'unknown'}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 5xx and 429 are worth another go; a 4xx is a broken request or a bad key.
    throw new DiditTransportError(
      `didit responded ${res.status}`, res.status >= 500 || res.status === 429);
  }
  try {
    return await res.json();
  } catch {
    throw new DiditTransportError('didit returned a body that is not JSON', false);
  }
}

/**
 * Open a hosted verification session.
 *
 * `vendor_data` carries the challenge id and NOTHING else. It is our string
 * inside a third party's system and it comes back in webhook payloads, so a
 * parent's email or a child's name in that field would be a quiet export of
 * exactly the data this product is built not to export.
 */
export async function createSession(
  cfg: DiditConfig, challengeId: string, f: Fetcher = fetch,
): Promise<DiditSession> {
  const body: Record<string, unknown> = {
    workflow_id: cfg.workflowId,
    vendor_data: challengeId,
  };
  if (cfg.callbackUrl) body['callback'] = cfg.callbackUrl;

  const json = await call(f, `${cfg.baseUrl ?? DIDIT_BASE_URL}/v3/session/`, {
    method: 'POST', headers: headers(cfg), body: JSON.stringify(body),
  }, cfg.timeoutMs ?? 10_000) as { session_id?: unknown; url?: unknown };

  if (typeof json.session_id !== 'string' || typeof json.url !== 'string') {
    throw new DiditTransportError('didit session response missing session_id or url', false);
  }
  return { sessionId: json.session_id, url: json.url };
}

interface RawDecision {
  status?: unknown;
  id_verifications?: unknown;
}

/** Pull the first ID-verification report, whatever shape the array arrives in. */
function firstIdReport(raw: RawDecision): Record<string, unknown> {
  const arr = raw.id_verifications;
  if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0]) {
    return arr[0] as Record<string, unknown>;
  }
  return {};
}

/**
 * Read the verdict, and read nothing else.
 *
 * Everything this function does not destructure is data we never hold. That is
 * not an accident of implementation — it is the control.
 */
export async function fetchDecision(
  cfg: DiditConfig, sessionId: string, f: Fetcher = fetch, now: Date = new Date(),
): Promise<DiditOutcome> {
  const raw = await call(
    f,
    `${cfg.baseUrl ?? DIDIT_BASE_URL}/v3/session/${encodeURIComponent(sessionId)}/decision/`,
    { method: 'GET', headers: headers(cfg) },
    cfg.timeoutMs ?? 10_000,
  ) as RawDecision;

  const status = parseStatus(raw.status);
  if (status === null) {
    throw new DiditTransportError(
      'didit returned an unrecognised status — refusing to interpret it', false);
  }

  const id = firstIdReport(raw);
  const name = typeof id['full_name'] === 'string'
    ? id['full_name']
    : [id['first_name'], id['last_name']].filter((x) => typeof x === 'string').join(' ');

  return {
    status,
    isAdult: derivedIsAdult(id['age'], id['date_of_birth'], now),
    documentName: name,
  };
}
