/**
 * The second provider: an OpenAI-compatible endpoint we host ourselves.
 *
 * WHY THIS ONE, and not a hosted vendor. `docs/chittu-model-plan.md` phase 3
 * named Google Gemini, and Google's own API terms forbid it —
 * <https://ai.google.dev/gemini-api/terms>: "You must be 18 years of age or
 * older to use the APIs", and no use "directed towards or … likely to be
 * accessed by individuals under the age of 18". OpenAI is ruled out on the same
 * ground (landscape #19). A second Anthropic model would test the CELL layer
 * and nothing about the port.
 *
 * This one has no counterparty at all. It is also what architecture §12.2 says
 * the classifier must eventually be — "there is no kid-safety classifier to
 * buy … self-hosting the L2 classifier is not merely the cheaper option; it is
 * the only model-level option on the board. Nobody sells the thing."
 *
 * AND IT IS A PORT GAP, NOT A NEW FEATURE. `prototype/chittu-v3.html` has had
 * this path since v3 (`PROVIDER.mode = 'local'`, chittu-v3.html:652) with
 * twelve Playwright tests behind it (`tests/local-provider.spec.js`). The port
 * carried the Anthropic branch across and left this one behind, and
 * PORT-REVIEW did not record the omission.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES THAT A SECOND ANTHROPIC MODEL WOULD NOT
 *
 * The wire is genuinely different, which is the whole point of phase 3:
 *
 *                 Anthropic                     this
 *   path          /v1/messages                  /chat/completions
 *   system        a top-level field             folded into messages[0]
 *   auth          x-api-key header              optional bearer, often none
 *   reply         content[] blocks, typed       choices[0].message.content
 *
 * Everything above `route()` is unchanged, and that is the claim being tested.
 *
 * WHAT IT DOES NOT DO. It does not promote `chittu-local` to serve children.
 * That is phase 6 and is blocked on the Tamil eval set being rebuilt — a
 * self-hosted model cannot be promoted on an eval that cannot measure it. This
 * is the wire; the model behind it is a separate decision with its own gate.
 *
 * THE SAME RULES AS THE ANTHROPIC ADAPTER, for the same reasons:
 *
 * **No credential in a log, and no request body in an error.** A local endpoint
 * usually has no key at all, and when it does the bearer stays in this closure.
 * Errors carry a status and a short vendor message — never the request, which
 * holds a child's turn.
 *
 * **A hung endpoint must not hang a child's turn.** Every call has a timeout,
 * and this one is longer than Anthropic's: a 4B model on a laptop GPU is slower
 * than a hosted API, and a timeout tuned for the fast case would report a
 * working setup as an outage.
 *
 * **THIS ADAPTER DOES NOT STRIP CONTROL TOKENS.** It hands the reply over as
 * the model wrote it. The kernel's `stripControlTokens` SLICES at the last
 * closing tag and keeps what follows, and an adapter that deletes the tags
 * first leaves it nothing to find — which welds the model's reasoning onto its
 * answer and stops the escalation tokens matching. That matters more here than
 * anywhere: a fine-tuned Qwen3 emits `<think>…</think>` as an artefact of its
 * chat template, so this is the ordinary case rather than the edge one, and
 * `packages/pipeline` compares those tokens with `===`.
 */

import type { ModelReply, ModelRequest, ProviderAdapter, RouteDecision } from '@chittu/contracts';
import { ProviderError } from './anthropic.js';

export const LOCAL_ID = 'local';

/**
 * Declared, and read by nothing — the same state the Anthropic adapter's is in.
 * Making it live means applying it, and applying it as a DELETE after the
 * kernel's slice re-creates the weld for any vendor whose delimiters are not
 * `<think>`. See PORT-REVIEW.
 */
const CONTROL_TOKENS = /<\s*\/?\s*(?:thinking|think|reasoning|tool_call)\s*>|<\|[^>]*\|>/gi;

export interface LocalOptions {
  /** e.g. `http://127.0.0.1:11434/v1` for Ollama, `http://127.0.0.1:8080/v1` for mlx_lm. */
  readonly baseUrl: string;
  /** Most local servers need none. Sent as a bearer when present. */
  readonly apiKey?: string;
  /**
   * Longer than Anthropic's 20s on purpose: a 4B model on a laptop GPU is
   * slower than a hosted API, and a timeout tuned for the fast case reports a
   * working setup as an outage.
   */
  readonly timeoutMs?: number;
  /**
   * Shorter than `timeoutMs`, because the two calls fail differently. A slow
   * completion is a child waiting for their answer; a slow EMBEDDING is a child
   * waiting for an enrichment to an answer they will get either way. An
   * embedding model is also far smaller than a chat model, so a wait this long
   * means something is wrong rather than merely loaded.
   */
  readonly embedTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The OpenAI-compatible message shape: a string, or a list of content parts.
 *
 * THE SECOND HALF OF THE WIRE DIFFERENCE, and the reason this adapter earns
 * its keep. Anthropic wants `{type:'image', source:{type:'base64', media_type,
 * data}}`; every OpenAI-compatible server wants `{type:'image_url',
 * image_url:{url:'data:<mime>;base64,<data>'}}` — same bytes, different
 * envelope, and neither vendor errors on the other's shape in a way that says
 * "you sent the picture wrong". Sending Anthropic's block here produces a model
 * that never saw the picture, which is indistinguishable from a model that
 * cannot see, exactly as sending Anthropic's top-level `system` here produces a
 * model that never saw its own prompt.
 *
 * THIS IS THE WIRE, NOT A PROMOTION. `DEFAULT_CELLS.vision` names Anthropic,
 * and pointing it at `local` means pointing it at a model that can actually
 * see — `chittu-baseline` (qwen3:4b) cannot. Same rule as `embed`: a capability
 * is not something a cell assignment can confer. What this code guarantees is
 * that when there IS such a model, the picture reaches it in the shape it
 * expects.
 */
type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAiContentPart[];
};

/**
 * Attach the picture to the LAST user message. Image first, then text — the
 * prototype's order (chittu-v3.html:1126), because a model that reads "is my
 * drawing good?" before it has seen the drawing answers a different question.
 *
 * Nothing is carried forward: `req.messages` is a list of strings, so the only
 * picture on this wire is the one attached here, for this call.
 */
function withImage(req: ModelRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = req.messages.map(
    (m) => ({ role: m.role, content: m.content }));
  if (req.image === undefined) return messages;

  const part: OpenAiContentPart = {
    type: 'image_url',
    image_url: { url: `data:${req.image.mimeType};base64,${req.image.dataBase64}` },
  };
  const i = messages.findLastIndex((m) => m.role === 'user');
  // Dropping it silently would look exactly like a model that ignored it.
  if (i === -1) return [...messages, { role: 'user', content: [part] }];

  const text = messages[i]!.content;
  messages[i] = {
    role: 'user',
    content: typeof text === 'string' && text !== ''
      ? [part, { type: 'text', text }]
      : [part],
  };
  return messages;
}

interface OpenAiChoice { message?: { role?: string; content?: string } }
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export function localAdapter(opts: LocalOptions): ProviderAdapter {
  const {
    baseUrl,
    apiKey,
    timeoutMs = 60_000,
    embedTimeoutMs = 15_000,
    maxRetries = 1,
    fetchImpl = globalThis.fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  if (baseUrl === '') throw new Error('localAdapter needs a baseUrl');

  async function once(req: ModelRequest, route: RouteDecision): Promise<ModelReply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey !== undefined && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`;

    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: route.model,
        max_tokens: req.maxTokens ?? 1000,
        // THE SHAPE DIFFERENCE. There is no top-level `system` here; it is the
        // first message. Sending Anthropic's shape to this endpoint produces a
        // model that never saw its own prompt — which looks like a bad model
        // rather than a bad request, and is exactly the failure a second
        // provider exists to make visible.
        messages: [
          { role: 'system', content: req.system },
          ...withImage(req),
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json() as OpenAiResponse;
        detail = body.error?.message?.slice(0, 200) ?? detail;
      } catch { /* a non-JSON error body; the status is enough */ }
      throw new ProviderError(
        LOCAL_ID, res.status, `HTTP ${res.status} ${detail}`, RETRYABLE.has(res.status));
    }

    const body = await res.json() as OpenAiResponse;
    // As the model wrote it, control tokens and all — see the header.
    const text = (body.choices?.[0]?.message?.content ?? '').trim();

    if (text === '') {
      throw new ProviderError(LOCAL_ID, res.status, 'empty completion', true);
    }

    const reply: { text: string; tokensIn?: number; tokensOut?: number } = { text };
    // Most local servers report these; some do not. ABSENT, not zero — a zero
    // would be priced and stamped with a real rate version, and read on the ops
    // console as a call that cost nothing rather than one nobody counted.
    if (body.usage?.prompt_tokens !== undefined) reply.tokensIn = body.usage.prompt_tokens;
    if (body.usage?.completion_tokens !== undefined) {
      reply.tokensOut = body.usage.completion_tokens;
    }
    return reply;
  }

  return {
    id: LOCAL_ID,
    controlTokens: CONTROL_TOKENS,

    async complete(req, route) {
      let last: unknown;
      let wasRetryable = false;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return await once(req, route);
        } catch (e) {
          last = e;
          wasRetryable = e instanceof ProviderError
            ? e.retryable
            : e instanceof DOMException && e.name === 'TimeoutError';
          if (!wasRetryable || attempt === maxRetries) break;
          await sleep(250 * (attempt + 1));
        }
      }
      if (last instanceof ProviderError) throw last;
      if (last instanceof DOMException && last.name === 'TimeoutError') {
        throw new ProviderError(
          LOCAL_ID, null,
          `timed out after ${timeoutMs}ms — is the endpoint at ${baseUrl} running?`, true);
      }
      // A local endpoint that is simply not up is the commonest failure here,
      // and `fetch failed` on its own sends people to the wrong place.
      throw new ProviderError(
        LOCAL_ID, null,
        last instanceof Error
          ? `${last.message} (endpoint ${baseUrl})`
          : `request failed (endpoint ${baseUrl})`,
        wasRetryable);
    },

    /**
     * `/v1/embeddings` — the grounded corpus's retrieval vectors.
     *
     * THE SAME ENDPOINT, AND THAT IS THE ARGUMENT FOR IT BEING HERE. A child's
     * turn text is what gets embedded, so an embedding call is a call that
     * shows a vendor a child's words. `provider_clearance` exists to decide
     * which vendors may do that in which markets, and the header above says so
     * in as many words: "Being reachable is not being promoted: a cell still
     * has to name it, and provider_clearance still has to clear it."
     *
     * This method used to live in `apps/api/src/corpus/embed.ts` as a direct
     * fetch, which meant every embedding call bypassed clearance AND metering
     * entirely while the comment above claimed otherwise. Routing it through
     * the adapter is what makes the claim true.
     *
     * NO RETRY, deliberately, where `complete` has one. A dropped sandbox call
     * costs a child their answer; a dropped embedding costs them the GROUNDING
     * on an answer they still get. The pipeline marks the turn CORPUS
     * UNAVAILABLE and falls back to the truth wall, so failing fast is better
     * than holding a child's turn open to retry an enrichment.
     */
    async embed(req, route) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey !== undefined && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`;

      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: route.model, input: req.input }),
          signal: AbortSignal.timeout(embedTimeoutMs),
        });
      } catch (e) {
        // NO REQUEST BODY IN THE ERROR — it holds a child's turn. Same rule as
        // `complete`, and it matters identically here.
        throw new ProviderError(
          LOCAL_ID, null,
          e instanceof DOMException && e.name === 'TimeoutError'
            ? `embeddings timed out after ${embedTimeoutMs}ms (endpoint ${baseUrl})`
            : `embeddings request failed (endpoint ${baseUrl})`,
          true);
      }

      if (!res.ok) {
        let detail = res.statusText;
        try {
          const body = await res.json() as { error?: { message?: string } };
          detail = body.error?.message?.slice(0, 200) ?? detail;
        } catch { /* a non-JSON error body; the status is enough */ }
        throw new ProviderError(
          LOCAL_ID, res.status, `embeddings HTTP ${res.status} ${detail}`,
          RETRYABLE.has(res.status));
      }

      const body = await res.json() as {
        data?: { embedding?: number[] }[];
        usage?: { prompt_tokens?: number };
      };
      const vector = body.data?.[0]?.embedding;
      /**
       * NEVER a zero vector, and never an empty one. A zero vector is a valid
       * `vector(1024)`: pgvector would rank the whole corpus against it and
       * hand back its three nearest neighbours — arbitrary facts, ordered
       * confidently, given to a model under a heading that reads "verified".
       * Worse than no grounding by a margin that is hard to overstate.
       */
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new ProviderError(LOCAL_ID, res.status, 'embeddings reply had no vector', true);
      }

      const reply: { vector: number[]; tokensIn?: number } = { vector };
      // Absent, not zero — same reason as `complete`: a zero is priced and
      // stamped with a real rate version, and reads on the ops console as a
      // call that cost nothing rather than one nobody counted.
      if (body.usage?.prompt_tokens !== undefined) reply.tokensIn = body.usage.prompt_tokens;
      return reply;
    },
  };
}
