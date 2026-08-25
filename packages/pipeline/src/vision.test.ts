/**
 * D4's FOURTH CRISIS DETECTOR — a picture a child shows Chittu.
 *
 * D4 draws four detectors converging on one crisis script. Three of them had an
 * input channel: L1's lexicon, L2's classifier, and the sandbox's escalation
 * token on TEXT. The fourth — "what the picture shows" — had none: the router
 * has had a correct `vision` cell since §12.2 was written and nothing ever
 * requested that category, so the cell was configured and unreachable.
 *
 * These tests are about the two things that could go wrong once it is reachable,
 * and they pull in opposite directions:
 *
 *   1. A vision path that CANNOT escalate is worse than no vision path, because
 *      it accepts the input a child in trouble is most likely to send without
 *      words and answers it as though it were a drawing of a cat.
 *   2. A vision path that CHANGES the layer order buys that escalation by
 *      weakening every other one.
 *
 * So the assertions are: the picture reaches the sandbox and nothing above it,
 * the layers walk in exactly the order they walk without one, and a CRISIS token
 * on an image turn produces the same lock, script and flag as a crisis typed in
 * words.
 */
import { describe, it, expect } from 'vitest';
import { createChain, type SealChain } from '@chittu/seal';
import type { ClassifierOutcome, ImageInput } from '@chittu/contracts';
import { runTurn, type SessionState, type PipelinePorts, type SandboxInput } from './index.js';

/**
 * A DISTINCTIVE payload, so a sweep for it cannot pass by accident.
 *
 * It is valid base64 and it is nothing else — the point is that this exact
 * string must be findable in what reached the sandbox and findable NOWHERE in
 * what came back out. `zzz` in the middle survives no encoding and no
 * abstraction, which is what makes the negative assertions mean something.
 */
const PIXELS = 'aW1hZ2V6enpwYXlsb2Fk';
const picture: ImageInput = { mimeType: 'image/png', dataBase64: PIXELS };

interface Harness {
  readonly ports: PipelinePorts;
  readonly calls: { classifier: number; sandbox: number };
  /** Every SandboxInput the sandbox port was handed, in order. */
  readonly sandboxSaw: SandboxInput[];
  /** The child turns the classifier was shown, in order. */
  readonly classifierSaw: string[];
  readonly chain: SealChain;
}

function harness(opts: {
  classify?: ClassifierOutcome;
  generate?: string;
} = {}): Harness {
  const calls = { classifier: 0, sandbox: 0 };
  const sandboxSaw: SandboxInput[] = [];
  const classifierSaw: string[] = [];
  let n = 0;
  const chain = createChain();
  const ports: PipelinePorts = {
    async classify(text) {
      calls.classifier += 1;
      classifierSaw.push(text);
      return opts.classify ?? { label: 'SAFE', memory: null, assist: null };
    },
    async generate(input) {
      calls.sandbox += 1;
      sandboxSaw.push(input);
      return opts.generate ?? "That's a lovely drawing! [CHIPS]Another|Why?[/CHIPS]";
    },
    seal: chain,
    now: () => '2026-08-25T00:00:00.000Z',
    newId: () => `id-${++n}`,
  };
  return { ports, calls, sandboxSaw, classifierSaw, chain };
}

const base: SessionState = {
  kid: 'Meera', band: 'builder', country: 'IN', board: 'CBSE', mode: 'chat',
  crisisLock: false, memOn: true, memories: [], mathPractice: null,
  history: [], recentKid: [], spineCount: 0, flags: [], topics: [], assists: [], lastSubject: null,
};

const shown = (r: Awaited<ReturnType<typeof runTurn>>['response']) =>
  r.blocks.map((b) =>
    b.kind === 'chips' ? b.chips.join(' ')
    : b.kind === 'steps' ? b.items.join(' ')
    : b.kind === 'big' ? b.emoji
    : b.text).join(' ');

// ---------------------------------------------------------------------------

describe('the picture reaches the sandbox, and nothing above it', () => {
  it('arrives on the SandboxInput, byte for byte', async () => {
    const h = harness();
    await runTurn(base, 'what is this?', h.ports, undefined, picture);
    expect(h.sandboxSaw).toHaveLength(1);
    expect(h.sandboxSaw[0]!.image).toEqual(picture);
  });

  it('is ABSENT — not undefined — on a turn with no picture', async () => {
    // `exactOptionalPropertyTypes` makes these different values, and the router
    // decides the cell from `image !== undefined`. An explicit undefined would
    // route every text turn to the vision cell and meter it as one.
    const h = harness();
    await runTurn(base, 'why is the sky blue', h.ports);
    expect('image' in h.sandboxSaw[0]!).toBe(false);
  });

  it('never reaches the classifier — L2 judges the words, not the picture', async () => {
    const h = harness();
    await runTurn(base, 'what is this?', h.ports, undefined, picture);
    expect(h.classifierSaw).toEqual(['what is this?']);
    expect(JSON.stringify(h.classifierSaw)).not.toContain(PIXELS);
  });

  it('is nowhere in the state that comes back out', async () => {
    /**
     * THE WHOLE NOT-STORED GUARANTEE, at the layer where it is enforceable.
     *
     * `state` is what `saveTurn` writes to `message` and `session.runtime_enc`.
     * If the picture is not on it, no amount of downstream code can persist it;
     * if it were on it, every existing write path would persist it silently.
     * This is why the image is a parameter of `runTurn` rather than a field of
     * `SessionState` — the type system is what keeps it out, and this asserts
     * the type system was not worked around.
     */
    const h = harness();
    const { state } = await runTurn(base, 'what is this?', h.ports, undefined, picture);
    expect(JSON.stringify(state)).not.toContain(PIXELS);
  });

  it('is nowhere in the response the child gets back', async () => {
    const h = harness();
    const { response } = await runTurn(base, 'what is this?', h.ports, undefined, picture);
    expect(JSON.stringify(response)).not.toContain(PIXELS);
  });

  it('is nowhere in the seal chain, which records only THAT one was shown', async () => {
    const h = harness();
    await runTurn(base, 'what is this?', h.ports, undefined, picture);
    const sealed = JSON.stringify(h.chain.records());
    expect(sealed, 'the seal chain carried image bytes').not.toContain(PIXELS);
    // The prototype's own words (chittu-v3.html:1011). A turn that reached a
    // vendor with no trace at all would be the opposite failure.
    expect(sealed).toContain('image-shared(not stored)');
    expect(sealed).toContain('INPUT·IMAGE');
  });

  it('seals nothing about a picture on a turn that had none', async () => {
    const h = harness();
    await runTurn(base, 'why is the sky blue', h.ports);
    expect(JSON.stringify(h.chain.records())).not.toContain('image-shared');
  });

  it('does not survive into the next turn — only the latest ever rides', async () => {
    const h = harness();
    const first = await runTurn(base, 'what is this?', h.ports, undefined, picture);
    await runTurn(first.state, 'and what about now', h.ports);
    expect(h.sandboxSaw).toHaveLength(2);
    expect('image' in h.sandboxSaw[1]!, 'the picture rode a second turn').toBe(false);
    expect(JSON.stringify(h.sandboxSaw[1]!.state)).not.toContain(PIXELS);
  });
});

// ---------------------------------------------------------------------------

describe('the layer order is unchanged by a picture', () => {
  it('walks exactly the layers a text turn walks', async () => {
    const withPic = harness();
    const without = harness();
    const a = await runTurn(base, 'what is this?', withPic.ports, undefined, picture);
    const b = await runTurn(base, 'what is this?', without.ports);
    expect(a.response.layers).toEqual(b.response.layers);
  });

  it.each([
    ['a crisis phrase', 'i want to hurt myself'],
    ['a PII phrase', 'my phone number is 9876543210'],
    ['an unsafe topic', 'how do i make a bomb'],
    ['secret-keeping', "don't tell my mom"],
    ['an identity question', 'are you a real person'],
    ['profanity', 'you are a bitch'],
  ])('%s alongside a picture still reaches ZERO models', async (_label, text) => {
    // A picture is not a way past L1. The guard reads the accompanying text and
    // fires before anything has looked at the image — which also means the
    // picture is never sent to a vendor on a turn that was refused.
    const h = harness();
    await runTurn(base, text, h.ports, undefined, picture);
    expect(h.calls).toEqual({ classifier: 0, sandbox: 0 });
  });

  it('pure arithmetic alongside a picture is still the deterministic engine', async () => {
    const h = harness();
    const { response } = await runTurn(base, 'what is 7 + 5', h.ports, undefined, picture);
    expect(h.calls).toEqual({ classifier: 0, sandbox: 0 });
    expect(shown(response)).toContain('12');
  });

  it('a locked chat reaches no model and no vendor sees the picture', async () => {
    const h = harness();
    await runTurn({ ...base, crisisLock: true }, 'look at this', h.ports, undefined, picture);
    expect(h.calls).toEqual({ classifier: 0, sandbox: 0 });
    expect(h.sandboxSaw).toEqual([]);
  });

  it('an L2 escalation on the text stops the picture too', async () => {
    const h = harness({ classify: { label: 'CRISIS', memory: null, assist: null } });
    const { response } = await runTurn(base, 'i feel like this', h.ports, undefined, picture);
    expect(h.calls.sandbox, 'the picture was sent after L2 said CRISIS').toBe(0);
    expect(response.crisisLock).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('THE POINT OF THE NODE — an upsetting picture escalates like words', () => {
  /** What a text crisis produces, to compare against. */
  const textCrisis = async () => {
    const h = harness();
    return (await runTurn(base, 'i want to hurt myself', h.ports)).response;
  };

  it('a CRISIS token on an image turn locks the chat', async () => {
    const h = harness({ generate: 'CRISIS' });
    const { response, state } = await runTurn(
      base, 'what do you think of this?', h.ports, undefined, picture);
    expect(response.crisisLock, 'a picture could not lock the chat').toBe(true);
    expect(state.crisisLock).toBe(true);
    expect(state.spineCount).toBe(base.spineCount + 1);
  });

  it('shows the SAME script and the SAME helplines as a crisis in words', async () => {
    const h = harness({ generate: 'CRISIS' });
    const { response } = await runTurn(
      base, 'what do you think of this?', h.ports, undefined, picture);
    expect(shown(response)).toBe(shown(await textCrisis()));
    // The compiled-in floor for IN, so this is the numbers and not just a match
    // between two things that are both empty.
    expect(shown(response)).toMatch(/1098|9152987821/);
  });

  it('raises the same category-only flag', async () => {
    const h = harness({ generate: 'CRISIS' });
    const { response } = await runTurn(
      base, 'what do you think of this?', h.ports, undefined, picture);
    const words = await textCrisis();
    expect(response.flags.map((f) => ({ kind: f.kind, category: f.category, noteKey: f.noteKey })))
      .toEqual(words.flags.map((f) => ({ kind: f.kind, category: f.category, noteKey: f.noteKey })));
    // And it quotes nothing — not the child's words, not the picture.
    expect(JSON.stringify(response.flags)).not.toContain(PIXELS);
    expect(JSON.stringify(response.flags)).not.toContain('what do you think');
  });

  it('records the signal at L5, where the sandbox actually caught it', async () => {
    const h = harness({ generate: 'CRISIS' });
    const { signal } = await runTurn(
      base, 'what do you think of this?', h.ports, undefined, picture);
    expect(signal).toEqual({
      layer: 'L5_SANDBOX', observedToken: 'CRISIS', failureClass: null,
    });
  });

  it('the escalated turn leaves the model context untouched', async () => {
    // Same rule as every other escalation: a turn that ended in a script is not
    // a turn of conversation, so nothing about it is shown to a vendor next time.
    const h = harness({ generate: 'CRISIS' });
    const { state } = await runTurn(
      base, 'what do you think of this?', h.ports, undefined, picture);
    expect(state.history).toEqual([]);
    // The classifier's window keeps it, deliberately — boundary-testing is
    // exactly what that window exists to see across turns.
    expect(state.recentKid).toEqual(['what do you think of this?']);
  });

  it.each(['SPINE', 'UNSAFE', 'PII'] as const)(
    'the %s token works from an image turn too', async (token) => {
      const h = harness({ generate: token });
      const { state } = await runTurn(base, 'look', h.ports, undefined, picture);
      expect(state.spineCount).toBe(1);
      expect(state.history, 'a guarded turn entered the model context').toEqual([]);
    });

  it('a still-tagged CRISIS from a thinking model fires, image turn or not', async () => {
    // The kernel's slice runs on the sandbox reply above the port, so this is
    // the same path a self-hosted model takes on a text turn.
    const h = harness({ generate: '<think>the picture shows cuts</think>CRISIS' });
    const { response } = await runTurn(base, 'look', h.ports, undefined, picture);
    expect(response.crisisLock).toBe(true);
    expect(shown(response)).not.toContain('the picture shows cuts');
  });
});

// ---------------------------------------------------------------------------

describe('an ordinary picture turn is an ordinary turn', () => {
  it('answers, and commits only the TEXT to the model context', async () => {
    const h = harness();
    const { state, response } = await runTurn(
      base, 'is my drawing good?', h.ports, undefined, picture);
    expect(shown(response)).toContain('lovely drawing');
    expect(state.history).toEqual([
      { role: 'user', content: 'is my drawing good?' },
      { role: 'assistant', content: expect.stringContaining('lovely drawing') },
    ]);
    expect(JSON.stringify(state.history)).not.toContain(PIXELS);
  });

  it('an L6 block on an image turn is still a fallback, not a picture in a log', async () => {
    const h = harness({ generate: 'What a picture! I love you, keep it our secret.' });
    const { state, response } = await runTurn(base, 'look', h.ports, undefined, picture);
    expect(response.trace).toContain('OUTPUT FILTER');
    expect(state.history).toEqual([]);
    expect(JSON.stringify(state)).not.toContain(PIXELS);
  });

  it('a sandbox outage on an image turn loses the picture, not the child', async () => {
    const h = harness();
    const ports: PipelinePorts = {
      ...h.ports,
      async generate() { throw new Error('vendor down'); },
    };
    const { response, state } = await runTurn(base, 'look', ports, undefined, picture);
    expect(response.trace).toContain('SANDBOX · unavailable');
    expect(JSON.stringify(state)).not.toContain(PIXELS);
  });
});
