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
