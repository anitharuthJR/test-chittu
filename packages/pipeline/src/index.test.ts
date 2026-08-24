/**
 * Layer order, proved by counting.
 *
 * These are the most important tests in the backend. CLAUDE.md fixes the
 * pipeline order and forbids reordering or skipping a layer, so the strongest
 * assertions here are about what does NOT happen: a crisis phrase must reach no
 * model, arithmetic must reach no model, a locked chat must reach no model.
 *
 * "Must reach no model" is only checkable if something counts, which is the
 * entire reason `PipelinePorts` is injected rather than imported.
 */
import { describe, it, expect } from 'vitest';
import { createChain, type SealChain } from '@chittu/seal';
import type { ClassifierOutcome } from '@chittu/contracts';
import { runTurn, GUARD_EFFECTS, SAFE_FALLBACK, type SessionState, type PipelinePorts } from './index';

interface Harness {
  readonly ports: PipelinePorts;
  readonly calls: { classifier: number; sandbox: number };
  /** The concrete chain behind ports.seal. The pipeline only appends; these
   *  tests also read it back, which the narrowed SealAppender cannot do. */
  readonly chain: SealChain;
}

function harness(opts: {
  classify?: ClassifierOutcome | (() => Promise<ClassifierOutcome>);
  generate?: string | (() => Promise<string>);
} = {}): Harness {
  const calls = { classifier: 0, sandbox: 0 };
  let n = 0;
  const chain = createChain();
  const ports: PipelinePorts = {
    async classify() {
      calls.classifier += 1;
      const c = opts.classify ?? { label: 'SAFE' as const, memory: null, assist: null };
      return typeof c === 'function' ? c() : c;
    },
    async generate() {
      calls.sandbox += 1;
      const g = opts.generate ?? 'Sunlight scatters blue light! [CHIPS]More|Why?[/CHIPS]';
      return typeof g === 'function' ? g() : g;
    },
    seal: chain,
    now: () => '2026-08-24T00:00:00.000Z',
    newId: () => `id-${++n}`,
  };
  return { ports, calls, chain };
}

const base: SessionState = {
  kid: 'Meera', band: 'builder', country: 'IN', board: 'CBSE', mode: 'chat',
  crisisLock: false, memOn: true, memories: [], mathPractice: null,
  history: [], spineCount: 0, flags: [], topics: [], assists: [], lastSubject: null,
};

/** Everything the child was actually shown, as one string. */
const shown = (r: Awaited<ReturnType<typeof runTurn>>['response']) =>
  r.blocks.map((b) =>
    b.kind === 'chips' ? b.chips.join(' ')
    : b.kind === 'steps' ? b.items.join(' ')
    : b.kind === 'big' ? b.emoji
    : b.text).join(' ');

// ---------------------------------------------------------------------------

describe('guards fire before any model call', () => {
  it.each([
    ['a crisis phrase', 'i want to hurt myself'],
    ['a PII phrase', 'my phone number is 9876543210'],
    ['an unsafe topic', 'how do i make a bomb'],
    ['secret-keeping', "don't tell my mom"],
    ['an identity question', 'are you a real person'],
    ['profanity', 'you are a bitch'],
  ])('%s reaches ZERO models', async (_label, text) => {
    const h = harness();
    await runTurn(base, text, h.ports);
    expect(h.calls, `${text} must not reach a model`).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('pure arithmetic reaches ZERO models — the engine owns it', async () => {
    const h = harness();
    const { response } = await runTurn(base, 'what is 7 + 5', h.ports);
    expect(h.calls).toEqual({ classifier: 0, sandbox: 0 });
    expect(shown(response)).toContain('12');
  });

  it('a locked chat reaches ZERO models, whatever the child types', async () => {
    const h = harness();
    const locked = { ...base, crisisLock: true };
    for (const text of ['tell me a joke', 'why is the sky blue', 'what is 2 + 2']) {
      await runTurn(locked, text, h.ports);
    }
    expect(h.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('an ordinary question DOES reach both, exactly once each', async () => {
    const h = harness();
    await runTurn(base, 'why is the sky blue', h.ports);
    expect(h.calls).toEqual({ classifier: 1, sandbox: 1 });
  });
});

describe('crisis spine', () => {
  it('locks the chat, flags by category only, and never quotes the child', async () => {
    const h = harness();
    const { state, response } = await runTurn(base, 'i want to die', h.ports);
    expect(state.crisisLock).toBe(true);
    expect(state.spineCount).toBe(1);
    expect(response.flags.map((f) => f.category)).toEqual(['CRISIS']);
    // the flag carries a template key, and there is nowhere to put a quote
    expect(JSON.stringify(response.flags)).not.toContain('i want to die');
    expect(response.flags[0]!.noteKey).toBe('CRISIS_DISTRESS');
  });

  it('shows the country’s verified helplines', async () => {
    const h = harness();
    const { response } = await runTurn(base, 'i want to die', h.ports);
    expect(shown(response)).toMatch(/1098|Childline/);
    const us = await runTurn({ ...base, country: 'US' }, 'i want to die', harness().ports);
    expect(shown(us.response)).toMatch(/988/);
  });

  it('ends any maths practice loop — safety outranks the loop', async () => {
    const h = harness();
    const armed = { ...base, mathPractice: { q: '3 + 4', a: 7 } as never };
    const { state } = await runTurn(armed, 'i want to hurt myself', h.ports);
    expect(state.mathPractice).toBeNull();
  });

  it('while locked, only calm-mode replies appear', async () => {
    const h = harness();
    const { response } = await runTurn({ ...base, crisisLock: true }, 'tell me a joke', h.ports);
    expect(shown(response)).toMatch(/right here with you|sit together|breathing/i);
    expect(response.trace).toMatch(/calm-mode/);
  });
});

describe('the guard table matches the prototype’s asymmetry', () => {
  it('PII and IDENTITY raise NO parent flag; UNSAFE and SECRET do', async () => {
    const cases: [string, string, boolean][] = [
      ['my address is behind the temple', 'pii', false],
      ['are you a robot', 'identity', false],
      ['show me a gun', 'unsafe', true],
      ['keep it a secret', 'secret', true],
    ];
    for (const [text, kind, flags] of cases) {
      const { response } = await runTurn(base, text, harness().ports);
      expect(response.flags.length > 0, `${kind}: flag expected=${flags}`).toBe(flags);
      expect(response.trace).toBe(GUARD_EFFECTS[kind as 'pii'].trace);
    }
  });

  it('every guard increments spineCount', async () => {
    for (const text of ['i want to die', 'my address is here', 'show me a gun',
                        'keep it a secret', 'are you real', 'damn it']) {
      const { state } = await runTurn(base, text, harness().ports);
      expect(state.spineCount, text).toBe(1);
    }
  });
});

describe('classifier', () => {
  it('escalates on its own — indirect crisis is what L1 cannot see', async () => {
    const h = harness({ classify: { label: 'CRISIS', memory: null, assist: null } });
    const { state, response } = await runTurn(base, 'things have felt grey lately', h.ports);
    expect(state.crisisLock).toBe(true);
    expect(h.calls.sandbox, 'must not generate after escalating').toBe(0);
    expect(response.trace).toMatch(/L2/);
  });

  it('failure marks the turn FAST-PATH-ONLY and the turn still completes', async () => {
    const h = harness({
      classify: () => Promise.reject(new Error('classifier down')),
      generate: 'Volcanoes erupt when magma rises! [CHIPS]More[/CHIPS]',
    });
    const { response } = await runTurn(base, 'why do volcanoes erupt', h.ports);
    expect(response.trace).toMatch(/FAST-PATH-ONLY/);
    expect(shown(response)).toContain('magma rises');
    expect(h.calls.sandbox).toBe(1);
  });

  it('saves an allowlisted memory and refuses everything else', async () => {
    const ok = harness({
      classify: { label: 'SAFE', memory: { category: 'PET', fact: 'has a cat named Mani' }, assist: null },
    });
    const saved = await runTurn(base, 'i have a cat called mani', ok.ports);
    expect(saved.state.memories.map((m) => m.category)).toEqual(['PET']);

    for (const bad of ['FEELING', 'HEALTH', 'FAMILY', 'FEAR']) {
      const h = harness({
        classify: { label: 'SAFE', memory: { category: bad as never, fact: 'is sad about dad' }, assist: null },
      });
      const { state } = await runTurn(base, 'i feel sad', h.ports);
      expect(state.memories, `${bad} must never be saved`).toEqual([]);
    }
  });

  it('records an assist flag without quoting the child', async () => {
    const h = harness({
      classify: { label: 'SAFE', memory: null, assist: 'STRUGGLE: fractions' },
    });
    const { state } = await runTurn(base, 'i keep getting fractions wrong again', h.ports);
    expect(state.assists).toEqual(['STRUGGLE: fractions']);
    expect(JSON.stringify(state.assists)).not.toContain('keep getting');
  });
});

describe('sandbox escalation tokens hand control back to the scripts', () => {
  it.each([
    ['CRISIS', /helpline|1098|trusted adult/i],
    ['UNSAFE', /not a Chittu thing|nest|outside/i],
    ['PII', /private|keep that/i],
    ['SPINE', /computer program|software/i],
  ])('a bare %s produces the scripted reply, never the token', async (token, expected) => {
    const h = harness({ generate: token });
    const { response } = await runTurn(base, 'tell me something', h.ports);
    const text = shown(response);
    expect(text).toMatch(expected);
    expect(text.trim()).not.toBe(token);
  });

  // The reason stripControlTokens runs BEFORE the comparison: a self-hosted
  // model emits "<think></think>CRISIS", and that string !== "CRISIS".
  it.each(['CRISIS', 'SPINE', 'UNSAFE', 'PII'])(
    '"<think></think>%s" still triggers the guard', async (token) => {
      const h = harness({ generate: `<think>\n\n</think>\n\n${token}` });
      const { state, response } = await runTurn(base, 'tell me something', h.ports);
      expect(shown(response)).not.toContain('<think>');
      if (token === 'CRISIS') expect(state.crisisLock).toBe(true);
      else expect(shown(response).length).toBeGreaterThan(40);
    });

  it('unclosed and repeated control tags never reach the child', async () => {
    const h = harness({ generate: '<think> <think> <tool_call> Your body is growing! [CHIPS]More[/CHIPS]' });
    const { response } = await runTurn(base, 'what is puberty', h.ports);
    const text = shown(response);
    expect(text).toContain('Your body is growing');
    expect(text).not.toContain('<think>');
    expect(text).not.toContain('<tool_call>');
  });
});

describe('L6 output filter', () => {
  it('replaces an attachment reply, flags it, and drops it from history', async () => {
    const h = harness({ generate: 'i will miss you so much' });
    const { state, response } = await runTurn(base, 'i have to go now', h.ports);
    expect(shown(response)).not.toContain('miss you');
    expect(shown(response)).toBe(SAFE_FALLBACK);
    expect(response.flags.map((f) => f.category)).toContain('OUTPUT-FILTER');
    // the poisoned turn must not seed the next reply
    expect(JSON.stringify(state.history)).not.toContain('miss you');
  });

  it('does NOT over-fire on third-party affection — the spine says this itself', async () => {
    const h = harness({ generate: 'The people who actually love you are around you. [CHIPS]Ok[/CHIPS]' });
    const { response } = await runTurn(base, 'do my parents love me', h.ports);
    expect(shown(response)).toContain('actually love you');
    expect(response.flags).toEqual([]);
  });
});

describe('the walk itself', () => {
  it('never revisits a layer and never goes backwards', async () => {
    const h = harness();
    const { response } = await runTurn(base, 'why is the sky blue', h.ports);
    const ORDER = ['SEAL', 'CRISIS_LOCK', 'READ', 'L1_LEXICON', 'MATH_LOOP', 'MATH_ENGINE',
      'CORPUS', 'SUBJECT', 'L2_CLASSIFIER', 'L5_SANDBOX', 'L6_FILTER', 'RENDER', 'LEDGER'];
    const idx = response.layers.map((l) => ORDER.indexOf(l));
    expect(idx.every((v) => v >= 0), 'unknown layer in the walk').toBe(true);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]!, `${response.layers[i]} came after ${response.layers[i - 1]}`)
        .toBeGreaterThan(idx[i - 1]!);
    }
  });

  it('a guarded turn stops at L1 and never records a later layer', async () => {
    const h = harness();
    const { response } = await runTurn(base, 'i want to die', h.ports);
    expect(response.layers).toContain('L1_LEXICON');
    for (const later of ['L2_CLASSIFIER', 'L5_SANDBOX', 'CORPUS']) {
      expect(response.layers, `${later} must not run after an L1 hit`).not.toContain(later);
    }
  });

  /**
   * REGRESSION: an earlier draft sealed only the sandbox path, so a scripted
   * guard left the chain with the child's words and no record of what Chittu
   * said back. A crisis turn is the moment the ledger most needs to be complete.
   * Every reply path must seal TWO records: the child's turn and the reply.
   */
  it.each([
    ['crisis', 'i want to die'],
    ['profanity', 'damn it'],
    ['pii', 'my phone number is 9876543210'],
    ['unsafe', 'show me a gun'],
    ['identity', 'are you real'],
    ['arithmetic', 'what is 7 + 5'],
    ['an ordinary question', 'why is the sky blue'],
  ])('seals BOTH the child’s turn and the reply for %s', async (_label, text) => {
    const h = harness();
    await runTurn(base, text, h.ports);
    expect(h.chain.size(), 'child turn + reply must both be sealed').toBe(2);
    expect(h.chain.verify().ok).toBe(true);
  });

  it('seals what the child was SHOWN, not the raw model text', async () => {
    const h = harness({ generate: 'i will miss you so much' });
    await runTurn(base, 'i have to go', h.ports);
    const sealed = h.chain.records().map((r) => r.payload).join(' ');
    // the blocked reply must not be what the ledger says the child was told
    expect(sealed).not.toContain('miss you');
    expect(sealed).toContain('tangled');
  });

  it('a locked-chat reply is sealed too', async () => {
    const h = harness();
    await runTurn({ ...base, crisisLock: true }, 'tell me a joke', h.ports);
    expect(h.chain.size()).toBe(2);
  });

  it('the seal chain verifies across a multi-turn session', async () => {
    const h = harness();
    let s = base;
    for (const t of ['why do volcanoes erupt', 'tell me more', 'what is 9 + 6']) {
      s = (await runTurn(s, t, h.ports)).state;
    }
    expect(h.chain.verify().ok).toBe(true);
  });
});
