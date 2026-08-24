/**
 * The Anthropic adapter. One vendor, behind the port.
 *
 * Rules this file exists to keep:
 *
 * **The key never leaves this module and never reaches a log.** It is read from
 * the environment, held in a closure, and set on one header. Errors carry a
 * status and a short vendor message, never the request body — a child's turn is
 * in that body.
 *
 * **A hung provider must not hang a child's turn.** Every call has an
 * `AbortSignal` timeout. A turn that takes forever is a turn a child stares at.
 *
 * **Retries are bounded and only for the retryable.** 429 and 5xx get one
 * retry with a short backoff; a 400 means our request is wrong and repeating it
 * just burns money and time.
 *
 * **The vendor's own litter is stripped here**, before the reply reaches the
 * pipeline. L6 strips again on the way out — see `stripControlTokens` in the
 * kernel — because a second wall costs nothing and this one is vendor-specific.
 */

import type { ModelReply, ModelRequest, ProviderAdapter, RouteDecision } from '@chittu/contracts';

export const ANTHROPIC_ID = 'anthropic';

/** `<think>`-style leakage and `<|…|>` special tokens, whoever emitted them. */
const CONTROL_TOKENS = /<\/?(?:think|thinking|reasoning|tool_call)>|<\|[^|>]*\|>/gi;

export interface AnthropicOptions {
  readonly apiKey: string;
  /** Overridable so tests can point at a local server, and for a gateway. */
  readonly baseUrl?: string;
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Injected in tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected so the retry backoff does not really sleep in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

interface AnthropicContentBlock { type: string; text?: string }
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export function anthropicAdapter(opts: AnthropicOptions): ProviderAdapter {
  const {
    apiKey,
    baseUrl = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com',
    version = '2023-06-01',
    timeoutMs = 20_000,
    maxRetries = 1,
    fetchImpl = globalThis.fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  if (apiKey === '') throw new Error('anthropicAdapter needs an API key');

  async function once(req: ModelRequest, route: RouteDecision): Promise<ModelReply> {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
      },
      body: JSON.stringify({
        model: route.model,
        max_tokens: req.maxTokens ?? 1000,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // The vendor's message only — never the request, which holds a child's
      // words. `res.text()` is bounded because we slice it.
      let detail = res.statusText;
      try {
        const body = await res.json() as AnthropicResponse;
        detail = body.error?.message?.slice(0, 200) ?? detail;
      } catch { /* a non-JSON error body; the status is enough */ }
      throw new ProviderError(
        ANTHROPIC_ID, res.status, `HTTP ${res.status} ${detail}`, RETRYABLE.has(res.status));
    }

    const body = await res.json() as AnthropicResponse;
    const text = (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join(' ')
      .replace(CONTROL_TOKENS, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // An empty completion is a failure, not an answer. Returning '' would let
    // the pipeline treat "the vendor said nothing" as "the model chose silence".
    if (text === '') {
      throw new ProviderError(ANTHROPIC_ID, res.status, 'empty completion', true);
    }

    const reply: { text: string; tokensIn?: number; tokensOut?: number } = { text };
    if (body.usage?.input_tokens !== undefined) reply.tokensIn = body.usage.input_tokens;
    if (body.usage?.output_tokens !== undefined) reply.tokensOut = body.usage.output_tokens;
    return reply;
  }

  return {
    id: ANTHROPIC_ID,
    controlTokens: CONTROL_TOKENS,

    async complete(req, route) {
      let last: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return await once(req, route);
        } catch (e) {
          last = e;
          const retryable = e instanceof ProviderError
            ? e.retryable
            // A timeout or a dropped socket is worth one more go; a
            // programming error is not.
            : e instanceof DOMException && e.name === 'TimeoutError';
          if (!retryable || attempt === maxRetries) break;
          await sleep(250 * (attempt + 1));
        }
      }
      if (last instanceof ProviderError) throw last;
      if (last instanceof DOMException && last.name === 'TimeoutError') {
        throw new ProviderError(ANTHROPIC_ID, null, `timed out after ${timeoutMs}ms`, true);
      }
      throw new ProviderError(
        ANTHROPIC_ID, null,
        last instanceof Error ? last.message : 'request failed', true);
    },
  };
}
