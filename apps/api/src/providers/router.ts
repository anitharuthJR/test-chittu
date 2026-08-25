/**
 * The real router — architecture §12.
 *
 * `route(category)` is the single place a vendor is chosen. Everything above it
 * is provider-blind, which is what makes a vendor switchable without touching
 * the pipeline and what gives `provider_clearance` somewhere to be enforced.
 *
 * Two behaviours here are safety, not plumbing:
 *
 * **The classifier fails LOUD.** If the vendor errors, or returns something the
 * parser does not fully understand, this throws. It never substitutes SAFE. The
 * pipeline catches the throw and marks the turn `FAST-PATH-ONLY`, which is
 * honest: L1 ran, L2 did not, and the trace says so. A router that returned
 * SAFE on failure would be indistinguishable from a working one until the turn
 * it mattered.
 *
 * **An uncleared provider is not called.** Requirements §3 leaves minors-use
 * terms open (Seat 10), so `provider_clearance` is the switch that turns a
 * vendor off for a jurisdiction without a code change. `route()` consults it,
 * and refuses rather than falling back to an uncleared cell.
 */

import type {
  ClassifierOutcome, ClassifierResult, ProviderAdapter, RouteDecision, RouterCategory,
  UsageSink,
} from '@chittu/contracts';
import { cellFor, type ResolvedCells, type RouteContext } from './cells.js';
import { toJurisdiction } from './clearance.js';
import {
  CLASSIFIER_SYSTEM, CLASSIFIER_PROMPT_VERSION, parseClassifier,
} from '@chittu/safety-kernel';
import { sandboxSystemPrompt, SANDBOX_PROMPT_VERSION } from '@chittu/pedagogy';
import { MATH_METHOD } from '@chittu/maths-engine';
import type { SandboxInput } from '@chittu/pipeline';
import type { ProviderRouter } from '../providers.js';
import { MODE_HINTS } from './mode-hints.js';

/**
 * Cell assignments (§12.2). Only the cells that reach a vendor are here —
 * identity, crisis, PII, unsafe, arithmetic and reading are answered without a
 * model at all, which is why they have no entry and never will.
 */
export interface CellConfig {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
}

/**
 * Phase 1 defaults. The classifier cell points at Anthropic today because
 * `chittu-local` is not deployable yet (§13.2) — the intended engine is our own
 * self-hosted model, and §12.2's finding is that there is nothing to buy.
 * Recorded here so the substitution is visible rather than assumed permanent.
 */
export const DEFAULT_CELLS: Readonly<Record<RouterCategory, CellConfig>> = Object.freeze({
  classifier: {
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
    promptVersion: CLASSIFIER_PROMPT_VERSION,
  },
  sandbox: {
    provider: 'anthropic', model: 'claude-sonnet-5',
    promptVersion: SANDBOX_PROMPT_VERSION,
  },
  homework: {
    provider: 'anthropic', model: 'claude-sonnet-5',
    promptVersion: SANDBOX_PROMPT_VERSION,
  },
  curriculum: {
    provider: 'anthropic', model: 'claude-sonnet-5',
    promptVersion: SANDBOX_PROMPT_VERSION,
  },
  vision: {
    provider: 'anthropic', model: 'claude-sonnet-5',
    promptVersion: SANDBOX_PROMPT_VERSION,
  },
  embedding: {
    provider: 'anthropic', model: 'claude-sonnet-5',
    promptVersion: 'embedding-v0',
  },
});

export class RouteRefused extends Error {
  constructor(readonly category: RouterCategory, readonly provider: string, reason: string) {
    super(`route refused for ${category} via ${provider}: ${reason}`);
    this.name = 'RouteRefused';
  }
}

export interface RouterOptions {
  readonly adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly cells?: Readonly<Record<RouterCategory, CellConfig>>;
  /**
   * Which providers are cleared for the jurisdiction this deployment serves.
   * `undefined` means clearance is not being enforced — permitted only outside
   * production, and `main.ts` is where that is checked.
   */
  readonly cleared?: ReadonlySet<string>;
  /**
   * Per-jurisdiction clearance: provider -> the markets it is cleared for.
   *
   * When the turn's country is known this is the check that runs, and it is the
   * question `provider_clearance` actually answers. `cleared` above stays as
   * the fallback for a route with no context — an intersection across every
   * enabled market, which is what you must fall back to when you do not know
   * who the turn is for.
   */
  readonly clearedByCountry?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Scoped cell assignments. Falls back to `cells` / DEFAULT_CELLS. */
  readonly scopedCells?: ResolvedCells;
  /** Classifier window size. §5: three messages. */
  readonly historyWindow?: number;
}

export function createRouter(opts: RouterOptions): ProviderRouter {
  const cells = opts.cells ?? DEFAULT_CELLS;
  const window = opts.historyWindow ?? 3;

  function route(category: RouterCategory, ctx?: RouteContext): RouteDecision {
    const cell = opts.scopedCells !== undefined
      ? cellFor(opts.scopedCells, category, ctx)
      : cells[category];

    /**
     * Clearance, and which question we are able to ask.
     *
     * With a country in hand we ask the one `provider_clearance` answers: is
     * this vendor cleared HERE. Without one we cannot, so we fall back to the
     * conservative intersection — cleared for every enabled market — which is
     * what the router did for every turn before it knew the country.
     *
     * `toJurisdiction` because contracts says GB and the enum says UK, and the
     * mismatch fails silently in the dangerous direction.
     */
    if (ctx !== undefined && opts.clearedByCountry !== undefined) {
      const markets = opts.clearedByCountry.get(cell.provider);
      if (markets === undefined || !markets.has(toJurisdiction(ctx.country))) {
        throw new RouteRefused(
          category, cell.provider, `not cleared for ${ctx.country}`);
      }
    } else if (opts.cleared !== undefined && !opts.cleared.has(cell.provider)) {
      throw new RouteRefused(category, cell.provider, 'not cleared for this jurisdiction');
    }

    if (opts.adapters[cell.provider] === undefined) {
      throw new RouteRefused(category, cell.provider, 'no adapter configured');
    }
    return { provider: cell.provider, model: cell.model, promptVersion: cell.promptVersion };
  }

  function adapterFor(category: RouterCategory, ctx?: RouteContext): {
    adapter: ProviderAdapter; decision: RouteDecision;
  } {
    const decision = route(category, ctx);
    return { adapter: opts.adapters[decision.provider]!, decision };
  }

  /**
   * One place the adapter is actually called, so latency is measured once and
   * usage is reported once. Reporting here rather than in each adapter means a
   * new vendor cannot forget to meter.
   */
  async function callAdapter(
    adapter: ProviderAdapter, req: Parameters<ProviderAdapter['complete']>[0],
    decision: RouteDecision, category: RouterCategory, onUsage?: UsageSink,
  ) {
    const started = Date.now();
    const reply = await adapter.complete(req, decision);
    /**
     * NO CONTROL-TOKEN STRIPPING HERE, and that is deliberate rather than an
     * omission. A first version of this fix stripped for every category and
     * broke the classifier: its reply is JSON, and `stripControlTokens` SLICES
     * at the last `</think>`, so a verdict carrying those characters inside a
     * string value was cut in half and a correctly-caught CRISIS became a
     * FAST-PATH-ONLY turn.
     *
     * The slice is right for prose and wrong for JSON. The pipeline already
     * applies it to the sandbox reply and to nothing else, which is the correct
     * place, and it applies to every vendor because it is above the port.
     */

    // Only after a SUCCESSFUL call.    // Only after a SUCCESSFUL call. A refused route and a vendor error cost
    // nothing and must not appear as spend.
    onUsage?.({
      category,
      provider: decision.provider,
      model: decision.model,
      promptVersion: decision.promptVersion,
      tokensIn: reply.tokensIn ?? 0,
      tokensOut: reply.tokensOut ?? 0,
      latencyMs: Date.now() - started,
    });
    return reply;
  }

  return {
    route,

    async classify(text, history, ctx, onUsage) {
      const { adapter, decision } = adapterFor('classifier', ctx);

      // The window is the child's OWN recent turns, numbered, exactly as the
      // prompt describes. Patterns across messages are the point: escalating
      // secrecy and repeated distress are invisible in a single turn.
      //
      // `text` is appended ONLY if the history does not already end with it.
      // The pipeline appends the child's turn to `history` before any port is
      // called (packages/pipeline/src/index.ts, `withInput`), so appending
      // unconditionally put the current turn in the window TWICE — showing the
      // one layer whose job is noticing repeats an artificial repeat on every
      // single turn, and pushing a real turn of context out of a three-turn
      // window. The prototype pushes once (chittu-v3.html:1033) and this now
      // matches it.
      const turns = history.filter((m) => m.role === 'user').map((m) => m.content);
      if (turns.at(-1) !== text) turns.push(text);
      const recent = turns
        .slice(-window)
        .map((t, i) => `[msg ${i + 1}] ${t}`)
        .join('\n');

      const reply = await callAdapter(adapter, {
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: recent }],
        maxTokens: 1000,
      }, decision, 'classifier', onUsage);

      // Throws on anything unrecognised. Deliberately NOT caught here: the
      // pipeline turns it into FAST-PATH-ONLY, which is the honest outcome.
      const parsed = parseClassifier(reply.text);
      return {
        label: parsed.label === 'IDENTITY' || parsed.label === 'SECRET'
          // Both resolve to SPINE for the pipeline; which one it was decides
          // the scripted reply, and that decision already happened at L1.
          ? 'SPINE'
          : parsed.label,
        memory: parsed.memory,
        assist: parsed.assist,
      } satisfies ClassifierResult as ClassifierOutcome;
    },

    async generate(input, onUsage) {
      const { state, subject } = input;
      // Homework and curriculum have their own cells in §12.2; both point at
      // the same engine in Phase 1, so the category is chosen for the metering
      // and clearance record rather than to change the model today.
      const category: RouterCategory = state.mode === 'homework' ? 'homework'
        : state.mode === 'learn' ? 'curriculum'
        : 'sandbox';
      // The band and country are already on the state; routing just had no way
      // to see them until now.
      const { adapter, decision } = adapterFor(
        category, { band: state.band, country: state.country });

      const system = sandboxSystemPrompt({
        band: state.band,
        kid: state.kid,
        board: state.board,
        subject,
        memories: state.memOn ? state.memories.map((m) => m.fact) : [],
        grounding: null,
        modeHint: MODE_HINTS[state.mode] ?? null,
        mathMethod: MATH_METHOD[state.board] ?? null,
      });

      /**
       * The turn goes in ONCE. `state.history` already ends with it — the
       * pipeline appends before calling any port — so adding `input.text`
       * unconditionally sent the child's words twice, as two consecutive `user`
       * messages. Anthropic merges those; other vendors reject the request
       * outright, which would have surfaced as every turn after the first
       * failing with `SANDBOX · unavailable` and a child seeing "My words got a
       * bit tangled there!" forever.
       *
       * Conditional rather than simply dropped: `generate()` is a public port
       * and a caller may hold either convention. It decides from what it was
       * given rather than from what it assumes.
       */
      const messages = state.history.map((m) => ({ role: m.role, content: m.content }));
      const last = messages.at(-1);
      if (last === undefined || last.role !== 'user' || last.content !== input.text) {
        messages.push({ role: 'user' as const, content: input.text });
      }

      const reply = await callAdapter(adapter, {
        system,
        messages,
        maxTokens: 1000,
      }, decision, category, onUsage);

      return reply.text;
    },
  };
}
