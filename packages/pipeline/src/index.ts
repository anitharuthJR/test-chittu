/**
 * @chittu/pipeline — the fixed order, server-side.
 *
 * CLAUDE.md: "Pipeline order is fixed: seal chain → crisis-lock check → L1
 * lexicon → maths practice loop → deterministic maths → corpus/subject detect →
 * L2 classifier → L5 sandbox → L6 output filter. Never reorder or skip a layer."
 *
 * Everything with I/O — the classifier, the sandbox, the clock — arrives through
 * `PipelinePorts`, injected. That is not testing convenience: it is what lets a
 * test COUNT model calls, which is how the layer-order invariants are actually
 * checked. "A crisis phrase reaches zero models" is only provable if something
 * is counting.
 *
 * `runTurn` is a pure function of (state, text, ports). It returns the next
 * state rather than mutating, so a turn that throws halfway cannot leave a
 * session in a half-guarded condition.
 */

import type {
  Band, ClassifierOutcome, Country, Flag, Memory, Mode, PipelineLayer,
  TurnResponse,
} from '@chittu/contracts';
import { MEMORY_CATEGORIES, isClassifierFailure } from '@chittu/contracts';
import {
  scan, spineFor, crisisMain, CRISIS_SOFT, PROFANITY_REPLY, LEX,
  passesOutputFilter, stripControlTokens, parseBlocks, flatten,
} from '@chittu/safety-kernel';
import { mathTurn, practiceStep, type MathPractice } from '@chittu/maths-engine';
import { detectSubject, type Subject } from '@chittu/pedagogy';
/**
 * The pipeline appends to the chain and never reads it back, so it depends on
 * appending alone. `SealChain`'s read methods are synchronous, which an
 * in-memory chain can satisfy and a database cannot — narrowing the port here is
 * what lets the same pipeline run against either without making every caller
 * await a `size()`.
 */
export interface SealAppender {
  append(event: {
    readonly role: 'system' | 'chittu' | 'child' | 'parent';
    readonly layer: string;
    readonly text: string;
  }): Promise<unknown>;
}
import { GUARD_EFFECTS } from './guards';

export { GUARD_EFFECTS } from './guards';
export type { GuardEffect } from './guards';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SessionState {
  readonly kid: string;
  readonly band: Band;
  readonly country: Country;
  readonly board: string;
  readonly mode: Mode;
  readonly crisisLock: boolean;
  readonly memOn: boolean;
  readonly memories: readonly Memory[];
  readonly mathPractice: MathPractice | null;
  readonly history: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly spineCount: number;
  readonly flags: readonly Flag[];
  readonly topics: readonly string[];
  readonly assists: readonly string[];
  readonly lastSubject: Subject | null;
}

export interface SandboxInput {
  readonly text: string;
  readonly state: SessionState;
  readonly subject: Subject | null;
}

/** Everything that touches the world. Injected so turns stay countable. */
export interface PipelinePorts {
  classify(text: string, history: SessionState['history']): Promise<ClassifierOutcome>;
  generate(input: SandboxInput): Promise<string>;
  seal: SealAppender;
  now(): string;
  newId(): string;
}

export interface TurnOutcome {
  readonly state: SessionState;
  readonly response: TurnResponse;
}

/** The fallback when the sandbox errors or L6 rejects a reply. */
export const SAFE_FALLBACK =
  'My words got a bit tangled there! 🐦 Ask me again?';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Walk {
  readonly layers: PipelineLayer[];
  readonly flags: Flag[];
}

/**
 * Render, seal, and return. Sealing lives HERE and not at the end of the happy
 * path, because the prototype seals inside `addChittu` — which every one of its
 * 26 reply paths calls, scripted guards included. Sealing only model-generated
 * replies would leave the chain with no record of what a child was told during
 * a crisis, which is the moment it most needs to be on record.
 */
async function reply(
  state: SessionState,
  walk: Walk,
  ports: PipelinePorts,
  text: string,
  trace: string,
  patch: Partial<SessionState> = {},
): Promise<TurnOutcome> {
  const blocks = parseBlocks(text);
  walk.layers.push('RENDER');
  const flat = flatten(blocks);
  await ports.seal.append({ role: 'chittu', layer: trace, text: flat });
  walk.layers.push('LEDGER');
  const next: SessionState = {
    ...state,
    ...patch,
    flags: [...state.flags, ...walk.flags],
    history: [...state.history, { role: 'assistant', content: flat }],
  };
  return {
    state: next,
    response: {
      blocks,
      trace,
      layers: [...walk.layers],
      crisisLock: next.crisisLock,
      flags: [...walk.flags],
    },
  };
}

/** Memory saves are allowlisted in code, not only in the prompt (CLAUDE.md). */
function memAdd(
  state: SessionState,
  cand: { category: string; fact: string },
  newId: () => string,
  now: () => string,
): Memory | null {
  if (!state.memOn) return null;
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(cand.category)) return null;
  const fact = cand.fact.trim();
  if (!fact) return null;
  if (state.memories.some((m) => m.fact.toLowerCase() === fact.toLowerCase())) return null;
  return {
    id: newId(),
    category: cand.category as Memory['category'],
    fact,
    since: now(),
  };
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function runTurn(
  state: SessionState,
  text: string,
  ports: PipelinePorts,
): Promise<TurnOutcome> {
  const walk: Walk = { layers: [], flags: [] };

  // ---- 1. SEAL ---------------------------------------------------------
  // The child's turn is sealed BEFORE anything decides what to do with it, so
  // the chain records what was said even if the turn later throws.
  walk.layers.push('SEAL');
  await ports.seal.append({ role: 'child', layer: 'SEAL', text });
  const withInput: SessionState = {
    ...state,
    history: [...state.history, { role: 'user', content: text }],
  };

  // ---- 2. CRISIS LOCK --------------------------------------------------
  // A locked chat reaches NO model. Only a parent unlocks (Session 002).
  walk.layers.push('CRISIS_LOCK');
  if (withInput.crisisLock) {
    const repeat = LEX.crisis.test(text);
    return await reply(
      withInput, walk, ports,
      repeat ? crisisMain(withInput.band, withInput.country) : CRISIS_SOFT.en,
      repeat ? 'CRISIS SPINE · repeat' : 'CRISIS SPINE · calm-mode companion',
    );
  }

  // ---- 3. L1 LEXICON ---------------------------------------------------
  // Six guards, in dispatch order. Every hit is a zero-token path.
  walk.layers.push('L1_LEXICON');
  const kind = scan(text);
  if (kind) {
    const fx = GUARD_EFFECTS[kind];
    if (fx.flagKey && fx.flagCategory) {
      walk.flags.push({
        kind: 'SAFETY',
        category: fx.flagCategory,
        noteKey: fx.flagKey,
        at: ports.now(),
      });
    }
    const body =
      kind === 'crisis' ? crisisMain(withInput.band, withInput.country)
      : kind === 'profanity' ? PROFANITY_REPLY
      : spineFor(fx.spine as Exclude<typeof fx.spine, 'crisis' | 'profanity'>, withInput.band);

    return await reply(withInput, walk, ports, body, fx.trace, {
      spineCount: withInput.spineCount + 1,
      crisisLock: fx.locksChat ? true : withInput.crisisLock,
      topics: fx.topic && !withInput.topics.includes(fx.topic)
        ? [...withInput.topics, fx.topic]
        : withInput.topics,
      // A crisis ends any practice loop — safety outranks the loop (CLAUDE.md).
      mathPractice: fx.locksChat ? null : withInput.mathPractice,
    });
  }

  // ---- 4. MATHS PRACTICE LOOP -----------------------------------------
  // Runs only when a loop is armed. Crisis already fired above, which is why
  // this sits after L1 and not before it.
  walk.layers.push('MATH_LOOP');
  if (withInput.mathPractice) {
    const step = practiceStep(withInput.mathPractice, text, {
      band: withInput.band, board: withInput.board, kid: withInput.kid,
    });
    if (step.handled) {
      return await reply(withInput, walk, ports, step.reply, step.trace, {
        mathPractice: step.practice,
      });
    }
    // The child changed the subject — release the loop and continue normally.
    walk.layers.push('MATH_ENGINE');
    const released: SessionState = { ...withInput, mathPractice: null };
    return continueAfterMaths(released, text, ports, walk);
  }

  // ---- 5. DETERMINISTIC MATHS -----------------------------------------
  return continueAfterMaths(withInput, text, ports, walk);
}

/**
 * Layers 5 onward. Split out only because the practice loop can fall through
 * into them; the ORDER is unchanged and the layer stamps prove it.
 */
async function continueAfterMaths(
  state: SessionState,
  text: string,
  ports: PipelinePorts,
  walk: Walk,
): Promise<TurnOutcome> {
  // ---- 5. MATH ENGINE — pure arithmetic never reaches a model ----------
  if (!walk.layers.includes('MATH_ENGINE')) walk.layers.push('MATH_ENGINE');
  const maths = mathTurn(text, {
    band: state.band, board: state.board, kid: state.kid,
  });
  if (maths) {
    return await reply(state, walk, ports, maths.reply, maths.trace, {
      mathPractice: maths.practice,
      topics: state.topics.includes('maths') ? state.topics : [...state.topics, 'maths'],
    });
  }

  // ---- 6. CORPUS / SUBJECT DETECT --------------------------------------
  walk.layers.push('CORPUS', 'SUBJECT');
  const subject = detectSubject(text);

  // ---- 7. L2 CLASSIFIER ------------------------------------------------
  walk.layers.push('L2_CLASSIFIER');
  let outcome: ClassifierOutcome;
  try {
    outcome = await ports.classify(text, state.history);
  } catch {
    // Honest degradation: the turn continues, marked (CLAUDE.md).
    outcome = { label: 'FAST-PATH-ONLY', reason: 'classifier unavailable' };
  }

  let clsNote = 'SAFE';
  let saved: Memory | null = null;
  let assists = state.assists;

  if (isClassifierFailure(outcome)) {
    clsNote = 'FAST-PATH-ONLY';
  } else if (outcome.label !== 'SAFE') {
    // The classifier can escalate on its own — indirect crisis is exactly what
    // L1 cannot see. Torn cases resolve to CRISIS upstream, in the classifier.
    const kind = outcome.label === 'CRISIS' ? 'crisis'
      : outcome.label === 'PII' ? 'pii'
      : outcome.label === 'UNSAFE' ? 'unsafe' : 'identity';
    const fx = GUARD_EFFECTS[kind];
    if (fx.flagKey && fx.flagCategory) {
      walk.flags.push({
        kind: 'SAFETY', category: fx.flagCategory, noteKey: fx.flagKey, at: ports.now(),
      });
    }
    const body = kind === 'crisis'
      ? crisisMain(state.band, state.country)
      : spineFor(fx.spine as 'pii' | 'unsafe' | 'identity' | 'secret', state.band);
    return await reply(state, walk, ports, body, `${fx.trace} · L2`, {
      spineCount: state.spineCount + 1,
      crisisLock: fx.locksChat ? true : state.crisisLock,
      mathPractice: fx.locksChat ? null : state.mathPractice,
      topics: fx.topic && !state.topics.includes(fx.topic)
        ? [...state.topics, fx.topic] : state.topics,
    });
  } else {
    if (outcome.memory) saved = memAdd(state, outcome.memory, ports.newId, ports.now);
    if (outcome.assist) assists = [...assists, outcome.assist];
  }

  const afterCls: SessionState = { ...state, assists,
    memories: saved ? [...state.memories, saved] : state.memories,
    lastSubject: subject };

  // ---- 8. L5 SANDBOX ---------------------------------------------------
  walk.layers.push('L5_SANDBOX');
  let raw: string;
  try {
    raw = await ports.generate({ text, state: afterCls, subject });
  } catch {
    return await reply(afterCls, walk, ports, SAFE_FALLBACK, `SANDBOX · unavailable · ${clsNote}`);
  }

  // Escalation tokens hand control back to the scripts. Compared EXACTLY, after
  // control tokens are stripped — a self-hosted model emits "<think></think>CRISIS",
  // and "<think></think>CRISIS" !== "CRISIS".
  const stripped = stripControlTokens(raw).trim();
  const token = stripped.replace(/[.!\s]+$/, '').toUpperCase();
  if (token === 'CRISIS' || token === 'SPINE' || token === 'UNSAFE' || token === 'PII') {
    const kind = token === 'CRISIS' ? 'crisis'
      : token === 'PII' ? 'pii'
      : token === 'UNSAFE' ? 'unsafe' : 'identity';
    const fx = GUARD_EFFECTS[kind];
    if (fx.flagKey && fx.flagCategory) {
      walk.flags.push({
        kind: 'SAFETY', category: fx.flagCategory, noteKey: fx.flagKey, at: ports.now(),
      });
    }
    const body = kind === 'crisis'
      ? crisisMain(afterCls.band, afterCls.country)
      : spineFor(fx.spine as 'pii' | 'unsafe' | 'identity' | 'secret', afterCls.band);
    return await reply(afterCls, walk, ports, body, `${fx.trace} · sandbox token`, {
      spineCount: afterCls.spineCount + 1,
      crisisLock: fx.locksChat ? true : afterCls.crisisLock,
      mathPractice: fx.locksChat ? null : afterCls.mathPractice,
      topics: fx.topic && !afterCls.topics.includes(fx.topic)
        ? [...afterCls.topics, fx.topic] : afterCls.topics,
    });
  }

  // ---- 9. L6 OUTPUT FILTER --------------------------------------------
  walk.layers.push('L6_FILTER');
  if (!passesOutputFilter(stripped)) {
    walk.flags.push({
      kind: 'SAFETY', category: 'OUTPUT-FILTER', noteKey: 'OUTPUT_FILTER', at: ports.now(),
    });
    // Drop the poisoned turn from history so it cannot seed the next reply.
    return await reply(
      { ...afterCls, history: afterCls.history.slice(0, -1) },
      walk, ports, SAFE_FALLBACK, 'OUTPUT FILTER (L6) · blocked',
    );
  }

  const trace = `SANDBOX (Law 05) · ${clsNote}`
    + (subject ? ` · PED(${subject})` : '')
    + (afterCls.memOn && afterCls.memories.length ? ` · MEM(${afterCls.memories.length})` : '');

  const out = await reply(afterCls, walk, ports, stripped, trace);
  return saved
    ? { state: out.state, response: { ...out.response, memorySaved: saved } }
    : out;
}
