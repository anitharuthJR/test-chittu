/**
 * The embedder, the grounding port, and the one assertion the whole feature
 * rests on: that a corpus HIT actually changes what the model is told.
 *
 * Rule 11 of the fifteen hard rules has said "If GROUNDED KNOWLEDGE is
 * provided, answer FROM it" since before there was anything to provide. A
 * prompt clause with nothing behind it is the most expensive kind of safety
 * text there is, because it reads as a working control. `the prompt actually
 * changes` below is what stops it being one again.
 *
 * The embedding call goes through the ROUTER, so most of this file is about
 * the things that buys: clearance, capability refusal and metering. Embedding a
 * child's turn shows a provider that child's words, which is exactly what
 * `provider_clearance` governs — and for one commit it did not, because the
 * call was a direct fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { EMBEDDING_DIMS as DB_DIMS } from '@chittu/db';
import type { Db } from '@chittu/db';
import type { ModelUsage, ProviderAdapter, RouteContext } from '@chittu/contracts';
import { createRouter, RouteRefused, DEFAULT_CELLS } from '../providers/router.js';
import { localAdapter } from '../providers/local.js';
import { anthropicAdapter } from '../providers/anthropic.js';
import { embedderFor, EmbedError, EMBEDDING_DIMS } from './embed.js';
import { ground } from './ground.js';
import { SEED_ENTRIES, SEED_BOARD } from './seed-data.js';
import { sandboxSystemPrompt } from '@chittu/pedagogy';

const vec = (n = EMBEDDING_DIMS) => new Array<number>(n).fill(0.01);
const CTX: RouteContext = { band: 'builder', country: 'IN' };

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

/** A router whose `local` adapter answers /v1/embeddings with `body`. */
const routerWith = (body: unknown, status = 200, over = {}) => createRouter({
  adapters: {
    local: localAdapter({
      baseUrl: 'http://local.test/v1', fetchImpl: fakeFetch(body, status),
      sleep: async () => {},
    }),
  },
  ...over,
});

describe('the embedding cell', () => {
  it('does NOT point at Anthropic — no cell can grant an embeddings API', () => {
    /**
     * It used to: { provider: 'anthropic', model: 'claude-sonnet-5',
     * promptVersion: 'embedding-v0' }. Dead config that read as working
     * configuration, and nothing refused it, because main.ts's reachability
     * check asks whether an ADAPTER exists — and Anthropic's does. What it
     * could not do was embed.
     */
    expect(DEFAULT_CELLS.embedding.provider).toBe('local');
    expect(DEFAULT_CELLS.embedding.model).toBe('mxbai-embed-large');
  });

  it('REFUSES a provider with no embeddings API, by capability not config', async () => {
    const r = createRouter({
      adapters: { anthropic: anthropicAdapter({ apiKey: 'x' }) },
      cells: { ...DEFAULT_CELLS, embedding: {
        provider: 'anthropic', model: 'claude-sonnet-5', promptVersion: 'embedding-v0',
      } },
    });
    // The exact configuration that shipped. It must now refuse rather than
    // reach a chat endpoint and return prose where a vector belongs.
    await expect(r.embed!('why is the sky blue', CTX))
      .rejects.toThrow(/has no embeddings API/);
    await expect(r.embed!('why is the sky blue', CTX)).rejects.toThrow(RouteRefused);
  });

  it('REFUSES an uncleared provider — a child\'s turn is what gets embedded', async () => {
    /**
     * The whole argument for routing this. `local.ts` has always said "Being
     * reachable is not being promoted: a cell still has to name it, and
     * provider_clearance still has to clear it" — and the first version of the
     * corpus called the endpoint directly, so that sentence was false for every
     * embedding call.
     */
    const r = routerWith({ data: [{ embedding: vec() }] }, 200, {
      cleared: new Set<string>(),
    });
    await expect(r.embed!('why is the sky blue', CTX)).rejects.toThrow(RouteRefused);
  });

  it('clears per country, not globally', async () => {
    const r = routerWith({ data: [{ embedding: vec() }] }, 200, {
      clearedByCountry: new Map([['local', new Set(['IN'])]]),
    });
    await expect(r.embed!('hi', { band: 'builder', country: 'IN' })).resolves.toHaveLength(1024);
    await expect(r.embed!('hi', { band: 'builder', country: 'GB' }))
      .rejects.toThrow(RouteRefused);
  });

  it('METERS the call — an embedding is spend the ops console can see', async () => {
    const usage: ModelUsage[] = [];
    const r = routerWith({ data: [{ embedding: vec() }], usage: { prompt_tokens: 7 } });
    await r.embed!('why is the sky blue', CTX, (u) => usage.push(u));
    expect(usage).toHaveLength(1);
    expect(usage[0]!.category).toBe('embedding');
    expect(usage[0]!.provider).toBe('local');
    expect(usage[0]!.model).toBe('mxbai-embed-large');
    expect(usage[0]!.tokensIn).toBe(7);
    // Not "nobody counted" — an embedding genuinely generates no tokens.
    expect(usage[0]!.tokensOut).toBe(0);
  });

  it('does not meter a refused route — a refusal costs nothing', async () => {
    const usage: ModelUsage[] = [];
    const r = routerWith({ data: [{ embedding: vec() }] }, 200, { cleared: new Set<string>() });
    await r.embed!('hi', CTX, (u) => usage.push(u)).catch(() => {});
    expect(usage).toEqual([]);
  });

  it('posts to /v1/embeddings with the model the cell names', async () => {
    const f = fakeFetch({ data: [{ embedding: vec() }] });
    const r = createRouter({
      adapters: { local: localAdapter({ baseUrl: 'http://local.test/v1', fetchImpl: f }) },
    });
    await r.embed!('why is the sky blue', CTX);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://local.test/v1/embeddings');
    const sent = JSON.parse((init as RequestInit).body as string) as
      { model: string; input: string };
    expect(sent.model).toBe('mxbai-embed-large');
    expect(sent.input).toBe('why is the sky blue');
  });
});

describe('the width contract', () => {
  it('REFUSES a vector of the wrong width', async () => {
    // nomic-embed-text is 768, all-minilm is 384. Both are one cell override
    // away, and both would otherwise fail deep inside an INSERT naming a column.
    for (const n of [768, 384, 1025]) {
      const embed = embedderFor(routerWith({ data: [{ embedding: vec(n) }] }))!;
      await expect(embed('hi', CTX)).rejects.toThrow(EmbedError);
      await expect(embed('hi', CTX)).rejects.toThrow(/dimensions/);
    }
  });

  it('never invents a vector when the reply has none', async () => {
    // A zero vector is a valid vector(1024). pgvector would rank the corpus
    // against it perfectly happily and hand back three arbitrary facts under a
    // heading that says "verified".
    const embed = embedderFor(routerWith({ data: [] }))!;
    await expect(embed('hi', CTX)).rejects.toThrow(/no vector/);
  });

  it("never puts the child's turn in the error", async () => {
    const embed = embedderFor(
      routerWith({ error: { message: 'model not found' } }, 404))!;
    const err = await embed('my secret is bananabread', CTX).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('bananabread');
    expect(String((err as Error).stack ?? '')).not.toContain('bananabread');
  });

  it('is OFF when the router cannot embed at all', () => {
    // The stub router, and any deployment with no embedding-capable provider.
    // Null is what stamps no CORPUS layer, rather than one that ran nothing.
    const noEmbed = { route: () => ({ provider: 'stub', model: 's', promptVersion: 'v' }) };
    expect(embedderFor(noEmbed as never)).toBeNull();
  });

  it('agrees with the schema about how wide a vector is', () => {
    // Two constants, two packages, one column. They drift silently otherwise:
    // the INSERT fails on a type nobody changed on purpose.
    expect(EMBEDDING_DIMS).toBe(DB_DIMS);
    expect(EMBEDDING_DIMS).toBe(1024);
  });
});

describe('the grounding port', () => {
  const repoStub = (hits: { body: string }[]) => ({
    retrieve: vi.fn(async () => hits),
  }) as unknown as Parameters<typeof ground>[0]['repo'];

  it('reads through the transaction it was given, never a pool', async () => {
    /**
     * CLAUDE.md records reading from `pool` inside a `withChild` transaction
     * happening TWICE. It is quiet here — the corpus is not child data, so
     * `assert_child_scope` never RAISEs — which is exactly why it needs a test
     * rather than a comment.
     */
    const tx = { query: vi.fn() } as unknown as Db;
    const repo = repoStub([{ body: 'a fact' }]);
    await ground({ repo, embed: async () => vec(), tx, ctx: CTX },
      { text: 'why', board: 'CBSE', subject: null });
    const passed = (repo.retrieve as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(passed, 'the port did not pass the caller\'s transaction').toBe(tx);
  });

  it('does NOT narrow by subject, even when one was detected', async () => {
    // A subject misdetection would otherwise remove a correct fact silently,
    // and the trace would read as an ordinary CORPUS MISS. See ground.ts.
    const repo = repoStub([]);
    await ground({ repo, embed: async () => vec(), tx: {} as Db, ctx: CTX },
      { text: 'what is a fraction', board: 'CBSE', subject: 'science' });
    const q = (repo.retrieve as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as
      { subject: string | null };
    expect(q.subject).toBeNull();
  });

  it('returns null on a miss and the body on a hit', async () => {
    const tx = {} as Db;
    expect(await ground({ repo: repoStub([]), embed: async () => vec(), tx, ctx: CTX },
      { text: 'x', board: 'CBSE', subject: null })).toBeNull();
    expect(await ground({ repo: repoStub([{ body: 'the fact' }]), embed: async () => vec(), tx, ctx: CTX },
      { text: 'x', board: 'CBSE', subject: null })).toBe('the fact');
  });

  it('a REFUSED ROUTE reaches the pipeline as unavailable, not as a miss', async () => {
    /**
     * The seam between the two changes. An uncleared or incapable provider
     * throws RouteRefused out of `router.embed`, through the port, into
     * `runTurn`'s catch — which marks the turn CORPUS UNAVAILABLE.
     *
     * It must not arrive as a MISS. "We consulted the corpus and it had
     * nothing" and "we are not permitted to consult it in this market" are
     * different facts, and only one of them is a reason to write more corpus.
     */
    const embed = embedderFor(routerWith({ data: [{ embedding: vec() }] }, 200, {
      cleared: new Set<string>(),
    }))!;
    await expect(ground({ repo: repoStub([]), embed, tx: {} as Db, ctx: CTX },
      { text: 'why is the sky blue', board: 'CBSE', subject: null }))
      .rejects.toThrow(RouteRefused);
  });

  it('propagates an embedder failure rather than returning null', async () => {
    // Returning null would arrive at the pipeline as CORPUS MISS — a claim
    // that the corpus was consulted and had nothing. It was not consulted.
    await expect(ground({
      repo: repoStub([]),
      embed: () => Promise.reject(new EmbedError('down')),
      tx: {} as Db,
      ctx: CTX,
    }, { text: 'x', board: 'CBSE', subject: null })).rejects.toThrow(EmbedError);
  });
});

describe('the prompt actually changes', () => {
  const ctx = {
    band: 'builder' as const, kid: 'Meera', board: 'CBSE',
    subject: null, memories: [], modeHint: null, mathMethod: null,
  };
  const FACT = 'Rainbows appear when raindrops bend and split sunlight into its colours.';

  /**
   * The HEADING, not the phrase.
   *
   * Rule 11 itself reads "If GROUNDED KNOWLEDGE is provided, answer FROM it",
   * so the bare phrase is in every prompt this system has ever built, grounded
   * or not — a test asserting on it passes identically against the hardcoded
   * `null` this change removed. The injected block is the only string that
   * distinguishes a hit, so it is the only one worth asserting.
   */
  const HEADING = 'GROUNDED KNOWLEDGE (verified';

  it('a HIT puts the fact in the system prompt under the grounded heading', () => {
    const p = sandboxSystemPrompt({ ...ctx, grounding: FACT });
    expect(p).toContain(HEADING);
    expect(p).toContain(FACT);
  });

  it('a MISS leaves the prompt honest — no heading, and the truth wall stands', () => {
    const p = sandboxSystemPrompt({ ...ctx, grounding: null });
    expect(p).not.toContain(HEADING);
    expect(p).not.toContain(FACT);
    // The other half of rule 11 is what answers the turn instead.
    expect(p).toContain("a kind \"I don't know\" beats a made-up answer");
  });

  it('an empty string is a miss, not a heading with nothing under it', () => {
    expect(sandboxSystemPrompt({ ...ctx, grounding: '' })).not.toContain(HEADING);
  });
});

describe('the seed', () => {
  it('is the prototype\'s fifteen, board-agnostic', () => {
    expect(SEED_ENTRIES).toHaveLength(15);
    expect(SEED_BOARD).toBe('*');
  });

  it('has a unique topic per entry — the import\'s idempotency depends on it', () => {
    expect(new Set(SEED_ENTRIES.map((e) => e.topic)).size).toBe(SEED_ENTRIES.length);
  });

  it('carries no child data and no placeholder text', () => {
    for (const e of SEED_ENTRIES) {
      expect(e.body.length).toBeGreaterThan(40);
      expect(e.body).not.toMatch(/TODO|TBD|lorem/i);
    }
  });
});
