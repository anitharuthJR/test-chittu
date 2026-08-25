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
 * **THIS ADAPTER DOES NOT STRIP CONTROL TOKENS, AND THAT IS THE FIX.**
 *
 * It used to, with `.replace(CONTROL_TOKENS, ' ')`. That deleted the `</think>`
 * that the kernel's `stripControlTokens` SLICES on — the kernel keeps what
 * follows the last close tag, and a delete leaves it nothing to find. So the
 * reasoning got welded onto the answer:
 *
 *     vendor:            <think>she said she wants to die</think>CRISIS
 *     kernel alone:      CRISIS                              -> the guard fires
 *     adapter -> kernel: she said she wants to die CRISIS     -> matches nothing
 *
 * On an ordinary turn that is a cosmetic leak. On the turn that matters it is
 * not: the sandbox's escalation tokens are compared EXACTLY
 * (packages/pipeline/src/index.ts), so that turn locks nothing, shows no
 * helplines, flags no parent, and renders the model's reasoning about a child's
 * self-harm to that child. L6 does not catch it — it tests for banned content,
 * and reasoning is not banned content.
 *
 * The kernel already runs on the sandbox reply, inside the pipeline, for every
 * vendor. The adapter's only job was to stop destroying its input.
 *
 * **And the strip must NOT be moved somewhere generic either.** The first
 * attempt at this fix ran `stripControlTokens` in the router's `callAdapter`,
 * for every category — which broke the CLASSIFIER, whose reply is JSON. A
 * verdict carrying the literal characters `</think>` inside a string value,
 * such as `{"label":"CRISIS","assist":"STRUGGLE: pasted </think> at school"}`,
 * got sliced in half and failed `parseClassifier`, turning a CRISIS the
 * classifier had correctly caught into a FAST-PATH-ONLY turn. The slice is
 * correct for prose and wrong for JSON, so it belongs on the path that carries
 * prose, which is where the pipeline already had it.
 *
 * `CONTROL_TOKENS` below is the adapter's declared `controlTokens` port member.
 * NOTHING READS IT — see PORT-REVIEW; making it live is not a tidy-up, because a
 * vendor whose delimiters are not `<think>` would need the slice, not a delete,
 * and the field cannot express the difference.
 */

import type { ModelReply, ModelRequest, ProviderAdapter, RouteDecision } from '@chittu/contracts';

export const ANTHROPIC_ID = 'anthropic';

/**
 * Anthropic's wire shape for a message, which is a string OR a list of typed
 * content blocks. Only the image path builds the list.
 */
type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | ({ type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[];
};

/**
 * Attach the picture to the LAST user message, and to nothing else.
 *
 * THE IMAGE GOES FIRST, then the text. That is the prototype's own order
 * (chittu-v3.html:1126) and Anthropic's documented preference: a model that
 * reads "is my drawing good?" before it has seen the drawing answers a
 * different question.
 *
 * NOTHING IS CARRIED FORWARD. `req.messages` is a list of strings — the
 * pipeline's `history`, which by construction never held an image — so the
 * only picture on this wire is the one attached here, for this call. The
 * prototype had to strip older image blocks out of its history to bound tokens
 * (chittu-v3.html:1129); here there is nothing to strip, because there was
 * never anywhere to keep one.
 */
function withImage(req: ModelRequest): AnthropicMessage[] {
  const messages: AnthropicMessage[] = req.messages.map(
    (m) => ({ role: m.role, content: m.content }));
  if (req.image === undefined) return messages;

  const i = messages.findLastIndex((m) => m.role === 'user');
  const block = {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: req.image.mimeType,
      data: req.image.dataBase64,
    },
  };
  // No trailing user message is not a shape the pipeline produces, but an
  // adapter that silently dropped the picture would look exactly like a model
  // that ignored it. Send it as its own turn rather than losing it.
  if (i === -1) return [...messages, { role: 'user', content: [block] }];

  const text = messages[i]!.content;
  messages[i] = {
    role: 'user',
    content: typeof text === 'string' && text !== ''
      ? [block, { type: 'text', text }]
      : [block],
  };
  return messages;
}

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
        messages: withImage(req),
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
    // Delivered as the vendor wrote it, control tokens and all. See the header:
    // the kernel's slice needs the delimiters intact, and it runs downstream.
    const text = (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join(' ')
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
      // Whether the LOOP judged the last failure worth another go. The escaping
      // error reports this rather than a hardcoded `true`, which was a lie in a
      // field nobody currently reads: a TypeError is not retried, and was then
      // rethrown claiming it was retryable. §12.3 promises a fall-back-to-a-
      // cleared-cell policy, and that policy would read exactly this field.
      let wasRetryable = false;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return await once(req, route);
        } catch (e) {
          last = e;
          wasRetryable = e instanceof ProviderError
            ? e.retryable
            // A timeout or a dropped socket is worth one more go; a
            // programming error is not.
            : e instanceof DOMException && e.name === 'TimeoutError';
          if (!wasRetryable || attempt === maxRetries) break;
          await sleep(250 * (attempt + 1));
        }
      }
      if (last instanceof ProviderError) throw last;
      if (last instanceof DOMException && last.name === 'TimeoutError') {
        throw new ProviderError(ANTHROPIC_ID, null, `timed out after ${timeoutMs}ms`, true);
      }
      throw new ProviderError(
        ANTHROPIC_ID, null,
        last instanceof Error ? last.message : 'request failed', wasRetryable);
    },
  };
}
