/**
 * The corpus's view of embedding: a width check, and nothing else.
 *
 * THE WIRE MOVED. This file used to hold a direct `fetch` to
 * `CHITTU_LOCAL_BASE_URL/v1/embeddings`, which meant every embedding call —
 * every one of which carries a child's turn verbatim to a provider — bypassed
 * `provider_clearance` and metering completely, while `local.ts`'s own header
 * said "provider_clearance still has to clear it". The call now goes through
 * `localAdapter.embed` and `router.embed`, so routing, clearance, refusal and
 * metering all apply to it exactly as they do to a sandbox call.
 *
 * What stays here is the one thing the router has no business knowing: how wide
 * a vector the CORPUS SCHEMA expects. `corpus_chunk.embedding` is
 * `vector(1024)`; the adapter returns whatever the model gave it.
 */

import type { RouteContext, UsageSink } from '@chittu/contracts';
import type { ProviderRouter } from '../providers.js';

/** Mirrors `EMBEDDING_DIMS` in @chittu/db; asserted equal in the tests. */
export const EMBEDDING_DIMS = 1024;

/**
 * `ctx` per call rather than per embedder: clearance is a per-country
 * question, and one process serves children in every enabled market.
 */
export interface Embedder {
  (text: string, ctx: RouteContext, onUsage?: UsageSink): Promise<number[]>;
}

export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedError';
  }
}

/**
 * Wraps a router's `embed` with the corpus's width contract.
 *
 * Returns null when the router has no `embed` at all — the stub router, or any
 * deployment with no embedding-capable provider. Null is what turns the corpus
 * OFF, and off is a visible state rather than a quiet one: `runTurn` stamps no
 * CORPUS layer when nothing is wired.
 */
export function embedderFor(router: ProviderRouter): Embedder | null {
  const embed = router.embed;
  if (embed === undefined) return null;

  return async function corpusEmbed(text, ctx, onUsage) {
    const vector = await embed.call(router, text, ctx, onUsage);

    /**
     * THE WIDTH CHECK CANNOT CATCH THE FAILURE THAT MATTERS, and it is worth
     * being clear about which half it does catch.
     *
     * It catches a model of the wrong SIZE — `nomic-embed-text` (768),
     * `all-minilm` (384) — which is one cell override away and would otherwise
     * fail deep inside an INSERT naming a column rather than a model.
     *
     * It cannot catch a DIFFERENT 1024-dimensional model. Those vectors are the
     * right width, the query runs, the index is used, and three chunks come
     * back — from a vector space with no relationship to the one the corpus was
     * embedded in. Confident, well-formed nonsense under a heading that says
     * "verified". Nothing in the schema or the types can see that, so the model
     * name is pinned in `seed-data.ts`'s provenance and changing it means
     * re-embedding the corpus.
     */
    if (vector.length !== EMBEDDING_DIMS) {
      throw new EmbedError(
        `embedding provider returned ${vector.length} dimensions, `
        + `but the corpus is ${EMBEDDING_DIMS} — re-embed the corpus or fix the cell`);
    }
    return vector;
  };
}

// ---------------------------------------------------------------------------
// What a deployment will actually SEE — the boot banner's one source of truth
// ---------------------------------------------------------------------------

/**
 * Three states, named after what appears in a TRACE rather than after how the
 * config looks, because the trace is where the question gets asked.
 *
 * - `off`        — no embedder wired. **No CORPUS layer in any walk, ever.**
 * - `unavailable`— an embedder IS wired and the route refuses it. **CORPUS is
 *                  stamped on every sandbox turn and every one reports
 *                  `CORPUS UNAVAILABLE`.**
 * - `on`         — wired and routable. CORPUS is stamped and reports
 *                  `GROUNDED CORPUS` or `CORPUS MISS`.
 *
 * `off` and `unavailable` USED TO BE REPORTED AS THE SAME THING, and they are
 * not remotely the same thing — which is the identical mistake the pipeline's
 * four grounding outcomes exist to prevent one level down. CLAUDE.md: "A miss
 * is a fact about the corpus, `unavailable` is a fact about the deployment."
 * Here: `off` is a fact about the BUILD ("this deployment has no embedder and
 * will never have one until it is restarted with different config") and
 * `unavailable` is a fact about ROUTING ("an embedder exists, and every call it
 * makes is being refused"). Only one of those is worth waking somebody for, and
 * only one of them explains a trace full of CORPUS UNAVAILABLE.
 */
export type CorpusState = 'off' | 'unavailable' | 'on';

export interface CorpusStatus {
  readonly state: CorpusState;
  /** One line for the boot banner. Says what a trace will look like. */
  readonly banner: string;
  /** Why, in the router's own words where it had any. */
  readonly reason: string;
  /** True exactly when `runTurn` will be handed a `ground` port. */
  readonly portWired: boolean;
}

/**
 * The banner's answer, derived from THE EMBEDDER THE SERVER ACTUALLY WIRED.
 *
 * `main.ts` used to answer this itself, with `router.route('embedding')` alone,
 * and got it wrong in both directions:
 *
 *   - **The stub router reported ON.** `stubRouter().route()` answers every
 *     category with `{provider:'stub', model:'stub-0'}` and never throws, so
 *     the banner printed `grounded corpus: ON — stub/stub-0` while
 *     `embedderFor` returned null, no port was wired, and no walk ever
 *     contained CORPUS. A banner that reads as a working control in review with
 *     nothing behind it — the same defect class as the CORPUS layer stamp that
 *     sat next to a bare `detectSubject()` call for months.
 *
 *   - **An Anthropic-only deployment reported OFF, and then stamped the layer
 *     anyway.** `createRouter` always defines `embed`, so `embedderFor` returns
 *     a live embedder even when `DEFAULT_CELLS.embedding` names `local` and no
 *     local adapter exists. The port was wired, CORPUS was stamped on every
 *     sandbox turn, and every retrieval reported UNAVAILABLE — while the banner
 *     said OFF and the line under it promised "no CORPUS layer will be
 *     stamped". That is every Anthropic-only deployment, which status §2b says
 *     is all of them.
 *
 * Taking the embedder as an ARGUMENT rather than recomputing it is the whole
 * point: `buildServer` passes the one it wired, so the banner and the wiring
 * cannot disagree. `portWired` is that same value restated as a boolean, and a
 * test pins the two together.
 */
export function corpusStatus(
  router: ProviderRouter, embedder: Embedder | null,
): CorpusStatus {
  if (embedder === null) {
    return {
      state: 'off',
      portWired: false,
      reason: 'the router has no embeddings capability at all',
      banner: 'OFF — no embedder is wired; no CORPUS layer will appear in any trace',
    };
  }

  /**
   * An embedder exists, so the port IS wired and CORPUS WILL be stamped. The
   * only remaining question is what it will say.
   *
   * No country in hand at boot, so `route()` applies the conservative rule —
   * cleared for every enabled market. That makes this answer pessimistic rather
   * than wrong: a provider cleared in IN but not GB refuses here and still
   * grounds an Indian child's turn at request time, where the country is known.
   * Said plainly in the banner rather than papered over.
   */
  try {
    const d = router.route('embedding');
    return {
      state: 'on',
      portWired: true,
      reason: `${d.provider}/${d.model}`,
      banner: `ON — ${d.provider}/${d.model}`,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      state: 'unavailable',
      portWired: true,
      reason,
      banner: `UNAVAILABLE — an embedder is wired but routing refuses it: ${reason}`,
    };
  }
}
