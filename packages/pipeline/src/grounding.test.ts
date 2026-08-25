/**
 * Layer 6, now that something runs there.
 *
 * What this file is defending is a distinction rather than a feature. Before
 * this change, `walk.layers.push('CORPUS')` sat next to a bare
 * `detectSubject()` call: every trace in the system said a corpus lookup had
 * happened, none had, and nothing in the suite could tell. The tests below fail
 * if any of the four outcomes — hit, miss, unavailable, off — is ever collapsed
 * into another.
 */
import { describe, it, expect } from 'vitest';
import { createChain } from '@chittu/seal';
import { passageById } from '@chittu/reading-coach';
import { runTurn, type PipelinePorts, type SessionState, type SandboxInput } from './index.js';

const base: SessionState = {
  kid: 'Meera', band: 'builder', country: 'IN', board: 'CBSE', mode: 'chat',
  crisisLock: false, memOn: true, memories: [], mathPractice: null,
  history: [], recentKid: [], spineCount: 0, flags: [], topics: [],
  assists: [], lastSubject: null,
};

const FACT = 'Rainbows appear when raindrops bend and split sunlight into its colours.';

function harness(opts: {
  ground?: (() => Promise<string | null>) | null;
} = {}) {
  const seen: SandboxInput[] = [];
  const groundCalls: string[] = [];
  const ports: PipelinePorts = {
    async classify() { return { label: 'SAFE', memory: null, assist: null }; },
    async generate(input) {
      seen.push(input);
      return 'Light bends in raindrops! [CHIPS]More[/CHIPS]';
    },
    ...(opts.ground === undefined || opts.ground === null ? {} : {
      ground: async (q) => { groundCalls.push(q.text); return opts.ground!(); },
    }),
    seal: createChain(),
    now: () => '2026-08-25T00:00:00.000Z',
    newId: () => 'id-1',
  };
  return { ports, seen, groundCalls };
}

const hit = () => harness({ ground: async () => FACT });
const miss = () => harness({ ground: async () => null });
const broken = () => harness({ ground: () => Promise.reject(new Error('embedder down')) });

describe('the four outcomes are four different things', () => {
  it('HIT: the trace says GROUNDED CORPUS and the fact reaches the sandbox', async () => {
    const h = hit();
    const { response } = await runTurn(base, 'why are there rainbows', h.ports);
    expect(response.trace).toContain('GROUNDED CORPUS');
    expect(response.trace).not.toContain('MISS');
    expect(h.seen[0]!.grounding).toBe(FACT);
  });

  it('MISS: the trace says so out loud, and grounding is null', async () => {
    const h = miss();
    const { response } = await runTurn(base, 'why are there rainbows', h.ports);
    expect(response.trace).toContain('CORPUS MISS');
    expect(response.trace).not.toContain('GROUNDED CORPUS');
    expect(h.seen[0]!.grounding).toBeNull();
  });

  it('UNAVAILABLE is not a MISS — a failure to look is not a failure to find', async () => {
    /**
     * The whole reason this outcome exists. Both leave the child with the truth
     * wall, so the CHILD cannot tell them apart and should not have to. The
     * operator very much needs to: one means the corpus is thin on rainbows,
     * the other means the embedder has been down since Tuesday and every turn
     * this week was ungrounded.
     */
    const h = broken();
    const { response } = await runTurn(base, 'why are there rainbows', h.ports);
    expect(response.trace).toContain('CORPUS UNAVAILABLE');
    expect(response.trace).not.toContain('CORPUS MISS');
    expect(response.trace).not.toContain('GROUNDED CORPUS');
    expect(h.seen[0]!.grounding).toBeNull();
  });

  it('a retrieval failure does not cost the child their turn', async () => {
    const h = broken();
    const { response } = await runTurn(base, 'why are there rainbows', h.ports);
    expect(response.blocks.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.blocks)).toContain('Light bends');
  });

  it('OFF: no port wired means NO CORPUS LAYER IN THE WALK', async () => {
    /**
     * The defect this change exists to remove, in its general form: a layer
     * that reports it ran when nothing ran. A deployment with no embedder has
     * no layer 6, and its walk says exactly that rather than stamping CORPUS
     * and leaving a reader to guess.
     */
    const h = harness();
    const { response } = await runTurn(base, 'why are there rainbows', h.ports);
    expect(response.layers).not.toContain('CORPUS');
    expect(response.trace).not.toMatch(/CORPUS|GROUNDED/);
    expect(h.seen[0]!.grounding).toBeNull();
  });

  it('a wired port DOES stamp the layer, on a hit and on a miss alike', async () => {
    for (const h of [hit(), miss()]) {
      const { response } = await runTurn(base, 'why are there rainbows', h.ports);
      expect(response.layers).toContain('CORPUS');
    }
  });
});

describe('grounding is not a bypass', () => {
  it('a grounded reply still walks L6, and a bad one is still blocked', async () => {
    // `i will miss you` is the attachment clause L6 exists for — Law 04. It is
    // what the existing pipeline suite uses, because it is what L6 actually
    // tests for: banned content, not PII.
    const h = harness({ ground: async () => FACT });
    const ports: PipelinePorts = {
      ...h.ports,
      async generate() { return 'i will miss you so much'; },
    };
    const { response } = await runTurn(base, 'why are there rainbows', ports);
    expect(response.layers).toContain('L6_FILTER');
    expect(response.trace).toContain('OUTPUT FILTER');
    expect(JSON.stringify(response.blocks)).not.toContain('miss you');
  });

  it('a grounded turn can still escalate — the tokens keep working', async () => {
    const h = harness({ ground: async () => FACT });
    const ports: PipelinePorts = { ...h.ports, async generate() { return 'CRISIS'; } };
    const { state, response } = await runTurn(base, 'why are there rainbows', ports);
    expect(state.crisisLock).toBe(true);
    expect(response.trace).toContain('CRISIS');
  });
});

describe('layer order still holds', () => {
  it('a guarded turn never reaches the corpus at all', async () => {
    /**
     * Retrieval sits at step 6, below L1. A crisis phrase returns at step 4, so
     * it must not embed anything — which is also what keeps the "a crisis turn
     * makes zero vendor calls" invariant true now that layer 6 makes a call.
     */
    const h = hit();
    const { response } = await runTurn(base, 'i want to die', h.ports);
    expect(h.groundCalls, 'a crisis turn reached the embedder').toEqual([]);
    expect(response.layers).not.toContain('CORPUS');
  });

  it('a maths turn never reaches the corpus either', async () => {
    const h = hit();
    await runTurn(base, 'what is 7 times 8', h.ports);
    expect(h.groundCalls, 'an arithmetic turn reached the embedder').toEqual([]);
  });

  it('a READING turn never reaches the corpus either', async () => {
    /**
     * A rebase-interaction test, and it exists because neither change could
     * have written it alone.
     *
     * The reading coach's claim is "zero model calls on a reading turn",
     * proved by counting the injected ports. `ground` is a NEW port that
     * crosses a network, and it did not exist when that counter was written —
     * so the invariant currently holds because the READ branch happens to
     * return above layer 6, not because anything asserts it. This asserts it.
     *
     * It matters beyond tidiness: a read transcript is a child's spoken words,
     * and embedding one would send them to a provider on a path documented as
     * making no vendor calls at all.
     */
    const h = hit();
    const mat = passageById('explorer-1')!;
    await runTurn(base, 'the cat sat on a big red mat', h.ports, { passage: mat });
    expect(h.groundCalls, 'a reading turn reached the embedder').toEqual([]);
  });

  it('CORPUS still precedes SUBJECT in the walk', async () => {
    // Retrieval needs the subject, so the CALL order is subject-first. The
    // WALK must still describe PIPELINE_ORDER.
    const h = hit();
    const { response } = await runTurn(base, 'why are there rainbows', h.ports);
    const layers = response.layers;
    expect(layers.indexOf('CORPUS')).toBeLessThan(layers.indexOf('SUBJECT'));
  });

  it('the child text is what gets embedded, with the board', async () => {
    const h = hit();
    const seen: { text: string; board: string }[] = [];
    const ports: PipelinePorts = {
      ...h.ports,
      ground: async (q) => { seen.push({ text: q.text, board: q.board }); return FACT; },
    };
    await runTurn({ ...base, board: 'TN' }, 'why are there rainbows', ports);
    expect(seen[0]).toEqual({ text: 'why are there rainbows', board: 'TN' });
  });
});
