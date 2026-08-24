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
} from '@chittu/contracts';
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
  /** Classifier window size. §5: three messages. */
  readonly historyWindow?: number;
}

export function createRouter(opts: RouterOptions): ProviderRouter {
  const cells = opts.cells ?? DEFAULT_CELLS;
  const window = opts.historyWindow ?? 3;

  function route(category: RouterCategory): RouteDecision {
    const cell = cells[category];
    if (opts.cleared !== undefined && !opts.cleared.has(cell.provider)) {
      throw new RouteRefused(category, cell.provider, 'not cleared for this jurisdiction');
    }
    if (opts.adapters[cell.provider] === undefined) {
      throw new RouteRefused(category, cell.provider, 'no adapter configured');
    }
    return { provider: cell.provider, model: cell.model, promptVersion: cell.promptVersion };
  }

  function adapterFor(category: RouterCategory): {
    adapter: ProviderAdapter; decision: RouteDecision;
  } {
    const decision = route(category);
    return { adapter: opts.adapters[decision.provider]!, decision };
  }

  return {
    route,

    async classify(text, history) {
      const { adapter, decision } = adapterFor('classifier');

      // The window is the child's OWN recent turns, numbered, exactly as the
      // prompt describes. Patterns across messages are the point: escalating
      // secrecy and repeated distress are invisible in a single turn.
      const recent = [...history.filter((m) => m.role === 'user'), { role: 'user', content: text }]
        .slice(-window)
        .map((m, i) => `[msg ${i + 1}] ${m.content}`)
        .join('\n');

      const reply = await adapter.complete({
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: recent }],
        maxTokens: 1000,
      }, decision);

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

    async generate(input) {
      const { state, subject } = input;
      // Homework and curriculum have their own cells in §12.2; both point at
      // the same engine in Phase 1, so the category is chosen for the metering
      // and clearance record rather than to change the model today.
      const category: RouterCategory = state.mode === 'homework' ? 'homework'
        : state.mode === 'learn' ? 'curriculum'
        : 'sandbox';
      const { adapter, decision } = adapterFor(category);

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

      const reply = await adapter.complete({
        system,
        messages: [
          ...state.history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content: input.text },
        ],
        maxTokens: 1000,
      }, decision);

      return reply.text;
    },
  };
}
