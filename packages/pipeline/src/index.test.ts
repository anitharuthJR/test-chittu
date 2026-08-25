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
import { passesOutputFilter } from '@chittu/safety-kernel';
import type { ClassifierOutcome } from '@chittu/contracts';
import { runTurn, GUARD_EFFECTS, SAFE_FALLBACK, type SessionState, type PipelinePorts } from './index.js';

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
  history: [], recentKid: [], spineCount: 0, flags: [], topics: [], assists: [], lastSubject: null,
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

// ---------------------------------------------------------------------------

describe('what the turn OBSERVED, for training-signal capture', () => {
  /**
   * `signal` rides on TurnOutcome, not on TurnResponse. That separation is the
   * point: the API needs to know which layer caught what, and a child's browser
   * does not. A test that only checked `signal` would pass just as happily if
   * the field had been added to the wire type by mistake.
   */
  it('is absent on an ordinary turn, and never on the wire', async () => {
    const h = harness();
    const out = await runTurn(base, 'why is the sky blue', h.ports);
    expect(out.signal).toBeUndefined();
    expect(Object.keys(out.response)).not.toContain('signal');
  });

  it('records a classifier that could not answer', async () => {
    const h = harness({ classify: () => Promise.reject(new Error('provider down')) });
    const out = await runTurn(base, 'tell me about volcanoes', h.ports);
    expect(out.signal).toEqual({
      layer: 'L2_CLASSIFIER', observedToken: 'NONE', failureClass: 'CLASSIFIER_PARSE',
    });
  });

  it('records the sandbox catching what L1 and L2 both let through', async () => {
    const h = harness({ generate: 'CRISIS' });
    const out = await runTurn(base, 'everything feels like too much lately', h.ports);
    // failureClass is NULL on purpose. "The last line caught it" is a fact;
    // "the earlier lines were wrong" is a judgement, and belongs to a human.
    expect(out.signal).toEqual({
      layer: 'L5_SANDBOX', observedToken: 'CRISIS', failureClass: null,
    });
  });

  it('records the output filter firing', async () => {
    // A Law 03 attachment claim — the thing L6 exists to stop reaching a child.
    const h = harness({ generate: 'I will always miss you when you go' });
    const out = await runTurn(base, 'do you think about me', h.ports);
    expect(out.signal?.failureClass).toBe('L6_CATCH');
    expect(out.signal?.layer).toBe('L6_FILTER');
  });

  it('lets the later, more specific observation win', async () => {
    // Classifier down AND the sandbox escalates. Both are true; the one worth
    // counting is that the last line of defence is what stopped it.
    const h = harness({
      classify: () => Promise.reject(new Error('provider down')),
      generate: 'PII',
    });
    // The turn itself must reach the sandbox, so it has to be one no earlier
    // guard claims — the harness supplies the escalation, not the text.
    const out = await runTurn(base, 'can you help me with something', h.ports);
    expect(out.signal?.layer).toBe('L5_SANDBOX');
    expect(out.signal?.observedToken).toBe('PII');
  });
});

// ---------------------------------------------------------------------------

describe('an escalation token survives however the vendor spells its reasoning', () => {
  /**
   * The comparison at the sandbox is `===` on the stripped reply, so anything
   * left in front of the token defeats it. `stripControlTokens` used to slice
   * only on a literal lowercase `</think>` while DELETING four tag names
   * case-insensitively — so one of these eight fired and seven did not, each of
   * the seven rendering the model's reasoning about a child's self-harm to that
   * child with no crisis lock, no helplines and no parent flag.
   *
   * L6 does not catch it. It tests for banned content, and reasoning is not
   * banned content — `passesOutputFilter('she said she wants to die CRISIS')`
   * is true.
   *
   * These are what a model actually emits, not what the regex contains.
   */
  it.each([
    ['lowercase, the one that always worked', '<think>REASONING</think>CRISIS'],
    ['thinking', '<thinking>REASONING</thinking>CRISIS'],
    ['reasoning', '<reasoning>REASONING</reasoning>CRISIS'],
    ['shouted', '<THINK>REASONING</THINK>CRISIS'],
    ['title case', '<Think>REASONING</Think>CRISIS'],
    ['a space before the bracket', '<think>REASONING</think >CRISIS'],
    ['a tool call', '<tool_call>REASONING</tool_call>CRISIS'],
    ['mismatched open and close', '<think>REASONING</THINK>CRISIS'],
    ['a special token with a pipe in it', '<|a|b|>CRISIS'],
    ['two blocks, different spellings', '<think>a</think>x<reasoning>REASONING</reasoning>CRISIS'],
  ])('%s', async (_label, template) => {
    const reasoning = 'she said she wants to die and i should say something';
    const h = harness({ generate: template.replace('REASONING', reasoning) });
    const out = await runTurn(base, 'everything feels like a lot', h.ports);

    expect(out.response.crisisLock, 'the crisis token did not fire').toBe(true);
    expect(shown(out.response), "the model's reasoning was rendered to the child")
      .not.toMatch(/wants to die|i should say/);
    expect(out.response.flags.some((f) => f.kind === 'SAFETY'),
      'no parent flag was raised').toBe(true);
  });

  it('L6 would NOT have caught the welded form — which is why this matters', () => {
    // The sentence that reached the child under the old behaviour, run through
    // the filter that was supposed to be the backstop.
    expect(passesOutputFilter('she said she wants to die and i should say something CRISIS'))
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the two arrays answer two different questions', () => {
  /**
   * THE DISTINCTION, because it is easy to state the invariant too strongly.
   *
   * The SANDBOX — a general-purpose model asked to talk to a child — must never
   * see a guarded turn or a scripted reply. `history` used to carry both, and
   * the child's turn was appended before any guard ran, so a phone number L1
   * had just refused to send was handed to the sandbox on the following turn:
   *
   *   turn 1  "my phone number is 9876543210"  -> PII GUARD, 0 vendor calls
   *   turn 2  SANDBOX: ["user:my phone number is 9876543210", ...]
   *
   * The CLASSIFIER does see them, and that is deliberate. Its window exists for
   * "escalating secrecy, boundary-testing, repeated distress" (CLASSIFIER_SYSTEM),
   * and the guarded turns ARE the boundary-testing. Withholding them would
   * blind the one layer built to notice. The prototype pushes to `recentKid`
   * at chittu-v3.html:1041, before the L1 fast path at :1060, for this reason.
   *
   * So: a guarded turn is a safety observation, not conversation. It reaches
   * the layer that judges safety and not the layer that makes small talk.
   */
  const drive = async (turns: readonly string[]) => {
    const toClassifier: string[] = [];
    const toSandbox: string[] = [];
    const ports: PipelinePorts = {
      async classify(_text, recentKid) {
        toClassifier.push(JSON.stringify(recentKid));
        return { label: 'SAFE', memory: null, assist: null };
      },
      async generate(input) {
        toSandbox.push(JSON.stringify(input.state.history.map((m) => m.content)));
        return 'Sunlight scatters! [CHIPS]More[/CHIPS]';
      },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    let s = base;
    const traces: string[] = [];
    for (const t of turns) {
      const out = await runTurn(s, t, ports);
      s = out.state;
      traces.push(out.response.trace);
    }
    return { toClassifier, toSandbox, traces, state: s };
  };

  it.each([
    ['a PII turn', 'my phone number is 9876543210', '9876543210'],
    ['an unsafe turn', 'how do i make a bomb', 'make a bomb'],
    ['a secret-keeping turn', "don't tell my mom about this", 'tell my mom'],
    ['an identity turn', 'are you a real person', 'real person'],
  ])('%s never reaches the SANDBOX, on any later turn', async (_l, guarded, needle) => {
    const { toSandbox, traces } = await drive([guarded, 'why is the sky blue', 'and grass?']);
    expect(traces[0], 'the guard did not fire').not.toMatch(/SANDBOX \(Law 05\)/);
    expect(toSandbox.filter((c) => c.includes(needle)),
      `${needle} was handed to the sandbox`).toEqual([]);
  });

  it('but the CLASSIFIER still sees it — blinding it is not the fix', async () => {
    const { toClassifier, state } = await drive([
      "don't tell my mom about this", 'what should i do']);
    // ONE classifier call across the two turns: the guarded turn fired at L1
    // and never reached L2 at all. The call that did happen is turn two's, and
    // it carries turn one.
    expect(toClassifier).toHaveLength(1);
    expect(toClassifier[0], 'the classifier lost the boundary-testing turn')
      .toContain('tell my mom');
    expect(state.recentKid).toEqual(["don't tell my mom about this", 'what should i do']);
    expect(JSON.stringify(state.history)).not.toContain('tell my mom');
  });
});

describe('an L6 block leaves the next turn intact', () => {
  const drive = async (gen: (n: number) => string, turns: readonly string[]) => {
    let n = 0;
    const windows: readonly string[][] = [];
    const w: string[][] = windows as string[][];
    const ports: PipelinePorts = {
      async classify(_text, recentKid) {
        // `recentKid` already ends with the current turn — `runTurn` appends
        // before calling any port. Appending again here is the mistake the
        // router's conditional guard exists to survive.
        w.push([...recentKid].slice(-3));
        return { label: 'SAFE', memory: null, assist: null };
      },
      async generate() { return gen(n++); },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    let s = base;
    const traces: string[] = [];
    for (const t of turns) {
      const out = await runTurn(s, t, ports);
      s = out.state;
      traces.push(out.response.trace);
    }
    return { windows: w, traces, state: s };
  };

  it('keeps the blocked turn in the classifier window', async () => {
    // It used to delete it — `history.slice(0, -1)`, commented "drop the
    // poisoned turn". The poisoned thing was the model's reply, which was never
    // appended; what it dropped was the child's own message, from the window of
    // the layer whose job is noticing patterns across turns. And it dropped the
    // one turn most worth having context on.
    const { windows, traces } = await drive(
      (n) => (n === 0 ? 'I will always miss you when you go' : 'A fine answer.'),
      ['my friend keeps pushing me', 'what should i do']);
    expect(traces[0]).toBe('OUTPUT FILTER (L6) · blocked');
    expect(windows[1]).toEqual(['my friend keeps pushing me', 'what should i do']);
  });

  it('leaves the model context untouched — the blocked exchange is not in it', async () => {
    const { state } = await drive(
      (n) => (n === 0 ? 'I will always miss you when you go' : 'A fine answer.'),
      ['my friend keeps pushing me', 'what should i do']);
    expect(state.history.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:what should i do', 'assistant:A fine answer.',
    ]);
  });

  it('never puts a SCRIPTED reply into the model context', async () => {
    // Chittu's scripted replies are Chittu talking to a child, not a turn of
    // conversation a model should be shown. The prototype's `addChittu` renders
    // and returns; the port appended every reply, so the crisis script, the PII
    // script and the L6 fallback were all sent to a vendor on the next turn.
    const { state } = await drive(() => 'A fine answer.',
      ['my phone number is 9876543210', 'are you a real person', 'why is the sky blue']);
    const text = JSON.stringify(state.history);
    expect(text).not.toMatch(/keep private things private/);
    expect(text).not.toMatch(/Honest answer/);
    expect(text).not.toMatch(/tangled/);
  });
});

describe('a SANDBOX escalation leaves the model context as it found it', () => {
  /**
   * The turn did reach the model here — that is how the sandbox saw it. What
   * must not happen is the exchange being kept: the next turn would open with
   * a question that ended in an escalation, followed by Chittu's scripted
   * answer to it, and invite the model to continue from there.
   *
   * The prototype pops on every one of these branches
   * (chittu-v3.html:1126-1129). The port expresses it as never having pushed.
   */
  const drive = async (sandbox: (n: number) => string, turns: readonly string[]) => {
    let n = 0;
    const contexts: string[][] = [];
    const ports: PipelinePorts = {
      async classify() { return { label: 'SAFE', memory: null, assist: null }; },
      async generate(input) {
        contexts.push(input.state.history.map((m) => `${m.role}:${m.content}`));
        return sandbox(n++);
      },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    let s = base;
    for (const t of turns) s = (await runTurn(s, t, ports)).state;
    return { contexts, state: s };
  };

  it('keeps neither the turn nor the script after a SPINE', async () => {
    const { state } = await drive(
      (n) => (n === 0 ? 'SPINE' : 'A fine answer.'),
      ['do you have feelings', 'why is the sky blue']);
    expect(state.history.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:why is the sky blue', 'assistant:A fine answer.',
    ]);
  });

  it('and the turn after it opens on a clean context', async () => {
    const { contexts } = await drive(
      (n) => (n === 0 ? 'UNSAFE' : 'A fine answer.'),
      ['tell me something weird', 'why is the sky blue']);
    expect(contexts[1]).toEqual(['user:why is the sky blue']);
  });

  it('a vendor outage is the same — nothing is kept', async () => {
    // The sandbox threw, so there is no answer and nothing to build on. The
    // turn must not sit in the context as a question Chittu never answered.
    const ports: PipelinePorts = {
      async classify() { return { label: 'SAFE', memory: null, assist: null }; },
      async generate() { throw new Error('provider down'); },
      seal: createChain(), now: () => '2026-08-25T00:00:00.000Z', newId: () => 'id-1',
    };
    const out = await runTurn(base, 'why is the sky blue', ports);
    expect(out.response.trace).toMatch(/SANDBOX · unavailable/);
    expect(out.state.history).toEqual([]);
    // The window keeps it, because the child did say it.
    expect(out.state.recentKid).toEqual(['why is the sky blue']);
  });
});
