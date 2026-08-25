/**
 * The provider router — requirements §9's "one router interface".
 *
 * `route(category)` is the single place a vendor is chosen, which is what makes
 * a vendor switchable without touching the pipeline, and what gives
 * provider_clearance somewhere to be enforced (chittu-architecture.md §12.3).
 *
 * Nothing below calls a real vendor yet. The stub exists so the whole service
 * runs, and is tested, with no key and no network — CI must never need either.
 */

import type {
  ClassifierOutcome, RouteContext, RouteDecision, RouterCategory, UsageSink,
} from '@chittu/contracts';
import type { SandboxInput } from '@chittu/pipeline';

export interface ProviderRouter {
  /**
   * `ctx` is optional here and not in the pipeline port, deliberately. A caller
   * that genuinely has no turn — a health check, an ops command — should be able
   * to ask what the unscoped assignment is. It just gets the conservative
   * clearance rule in exchange, because a route with no country cannot be
   * checked against a country.
   */
  route(category: RouterCategory, ctx?: RouteContext): RouteDecision;
  /**
   * `onUsage` is how metering gets its numbers without the router learning who
   * the turn belongs to. The caller passes a sink that already knows the
   * session; the router reports only what the call consumed.
   */
  classify(
    text: string,
    /** The child's OWN turns, newest last. Never Chittu's replies. */
    recentKid: readonly string[],
    ctx?: RouteContext,
    onUsage?: UsageSink,
  ): Promise<ClassifierOutcome>;
  generate(input: SandboxInput, onUsage?: UsageSink): Promise<string>;
  /**
   * A retrieval vector for the grounded corpus.
   *
   * OPTIONAL on this interface because the stub has no corpus and should not
   * pretend to — a deployment without embedding stamps NO CORPUS layer in the
   * walk, rather than one that ran nothing.
   *
   * `ctx` is NOT optional the way it is on `route()`. Every embedding call
   * carries a child's turn to a provider, so there is always a country to
   * check clearance against, and a caller that cannot supply one has no
   * business making the call.
   */
  embed?(text: string, ctx: RouteContext, onUsage?: UsageSink): Promise<number[]>;
}

/**
 * Deterministic, offline, and honest about it: everything classifies SAFE and
 * the sandbox echoes a fixed reply. Using this in production would mean the L2
 * layer inspects nothing, so `main.ts` refuses to start with it when
 * NODE_ENV=production.
 */
export function stubRouter(): ProviderRouter {
  return {
    route: (category) => ({
      provider: 'stub', model: 'stub-0', promptVersion: `${category}-v0`,
    }),
    async classify() {
      return { label: 'SAFE', memory: null, assist: null } satisfies ClassifierOutcome;
    },
    async generate(input) {
      return `I'm still learning that one, ${input.state.kid}! `
        + '[CHIPS]Tell me more|Something else[/CHIPS]';
    },
  };
}
