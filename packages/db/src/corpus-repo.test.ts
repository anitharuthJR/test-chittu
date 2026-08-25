/**
 * Corpus retrieval, against a real Postgres with a real pgvector index.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE EMBEDDER IS LEXICAL, AND SAYING SO IS THE POINT
 *
 * `embed()` below hashes tokens into dimensions and normalises. It is not
 * semantic and does not pretend to be: "what makes the sky that colour" shares
 * no tokens with the sky entry and this fixture will miss it, where
 * mxbai-embed-large would not.
 *
 * That is the honest split of what these tests cover. The SQL, the HNSW index,
 * the cosine ordering, the published-only filter, the board scope, the
 * distance floor and the dimension guard are OURS, and every one of them is
 * exercised here. Whether a real embedding model puts "why is the sky blue"
 * near the sky entry is a property of that model, tested by using it, not by
 * asserting it in a unit test with a stub that was built to agree.
 *
 * A stub that WAS built to agree is how three instruments in this repo came to
 * report success while measuring something else (CLAUDE.md). So the queries
 * below are written as a child would type them, and the fixture embedder is
 * allowed to miss.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './testing.js';
import { corpusRepo, BOARD_ANY, EMBEDDING_DIMS, type CorpusRepo } from './corpus-repo.js';

let db: TestDb;
let repo: CorpusRepo;
beforeAll(async () => {
  db = await createTestDb();
  repo = corpusRepo(db.pool);
}, 60_000);
afterAll(async () => { await db?.close(); });

/** Deterministic bag-of-words hashing into EMBEDDING_DIMS, L2-normalised. */
function embed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const h = createHash('sha256').update(tok).digest();
    v[h.readUInt32BE(0) % EMBEDDING_DIMS]! += 1;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

const SKY = 'The sky looks blue because sunlight is made of many colours, and tiny '
  + 'bits of air scatter blue light around the most.';
const VOLCANO = "A volcano is an opening in Earth's crust where melted rock escapes.";

/** Unique per run: the real-Postgres lane keeps the database between runs. */
const RUN = randomUUID().slice(0, 8);

async function publish(over: {
  body: string; topic: string; board?: string; subject?: string;
}): Promise<string> {
  const id = await repo.draft(db.pool, {
    board: over.board ?? BOARD_ANY,
    subject: over.subject ?? 'science',
    topic: `${over.topic}-${RUN}`,
    body: over.body,
    draftedBy: 'test',
    chunks: [{ body: over.body, embedding: embed(over.body) }],
  });
  await repo.sign(db.pool, id, 'editor@tulifo.ai');
  return id;
}

describe('retrieval', () => {
  it('finds anything at all — POSITIVE CONTROL', async () => {
    /**
     * A sweep that finds nothing looks exactly like one looking in the wrong
     * place (CLAUDE.md, and `signals.test.ts` carries the same guard). Every
     * assertion below this one is of the form "X is NOT returned", and all of
     * them would pass against a query with a typo'd table name, a wrong
     * enum literal, or a board filter that matches nothing.
     *
     * So: store a fact, ask for it in its own words, and require a hit.
     */
    await publish({ body: SKY, topic: 'sky' });
    const hits = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed(SKY),
    });
    expect(hits, 'retrieval returned nothing — it is not reaching any rows')
      .not.toEqual([]);
    expect(hits[0]!.body).toBe(SKY);
    expect(hits[0]!.distance).toBeLessThan(0.01);
  });

  it('ranks the nearer chunk first', async () => {
    await publish({ body: SKY, topic: 'sky-rank' });
    await publish({ body: VOLCANO, topic: 'volcano-rank' });
    const hits = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed('why is the sky blue and full of light'), limit: 5,
      maxDistance: 1,
    });
    expect(hits[0]!.body).toBe(SKY);
  });

  it('never returns a draft — only published is retrievable', async () => {
    const body = `Draft fact about quasars ${RUN}.`;
    // Deliberately identical embedding to the query, so this row is the
    // NEAREST possible match. If the state filter is wrong, it wins.
    await repo.draft(db.pool, {
      board: BOARD_ANY, subject: 'science', topic: `quasar-draft-${RUN}`,
      body, draftedBy: 'test',
      chunks: [{ body, embedding: embed(body) }],
    });
    const hits = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed(body), maxDistance: 1, limit: 10,
    });
    expect(hits.map((h) => h.body)).not.toContain(body);
  });

  it('never returns a retired entry', async () => {
    const body = `Retired fact about pagers ${RUN}.`;
    const id = await publish({ body, topic: 'pager' });
    await db.exec(`UPDATE corpus_entry SET retired_at = now() WHERE id = '${id}'`);
    const hits = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed(body), maxDistance: 1, limit: 10,
    });
    expect(hits.map((h) => h.body)).not.toContain(body);
  });

  it('scopes by board, and BOARD_ANY matches every board', async () => {
    const tnOnly = `Kaveri river flows through Tamil Nadu ${RUN}.`;
    const everywhere = `Rivers carry water to the sea ${RUN}.`;
    await publish({ body: tnOnly, topic: 'kaveri', board: 'TN', subject: 'geography' });
    await publish({ body: everywhere, topic: 'rivers', subject: 'geography' });

    const onTn = await repo.retrieve(db.pool, {
      board: 'TN', embedding: embed(tnOnly), maxDistance: 1, limit: 10,
    });
    expect(onTn.map((h) => h.body)).toContain(tnOnly);

    const onCbse = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed(tnOnly), maxDistance: 1, limit: 10,
    });
    expect(onCbse.map((h) => h.body),
      'a TN-only entry reached a CBSE child').not.toContain(tnOnly);
    // The control: the board filter is selective, not merely broken.
    expect(onCbse.map((h) => h.body)).toContain(everywhere);
  });

  it('the distance floor excludes an unrelated entry', async () => {
    await publish({ body: VOLCANO, topic: 'volcano-floor' });
    const hits = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed('what is a preposition in grammar'),
    });
    expect(hits.map((h) => h.body)).not.toContain(VOLCANO);
  });

  it('narrowing by subject is available and selective', async () => {
    // The pipeline does NOT use this — see corpus/ground.ts for why — but the
    // repo offers it, so it is proven rather than assumed.
    const body = `Adjectives describe nouns ${RUN}.`;
    await publish({ body, topic: 'adjectives', subject: 'english' });
    const wrong = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed(body), subject: 'science', maxDistance: 1, limit: 10,
    });
    expect(wrong.map((h) => h.body)).not.toContain(body);
    const right = await repo.retrieve(db.pool, {
      board: 'CBSE', embedding: embed(body), subject: 'english', maxDistance: 1, limit: 10,
    });
    expect(right.map((h) => h.body)).toContain(body);
  });
});

describe('the dimension guard', () => {
  it.each([[768], [384], [1025]])('refuses a %i-dimension vector', async (n) => {
    await expect(repo.retrieve(db.pool, {
      board: 'CBSE', embedding: new Array(n).fill(0.1) as number[],
    })).rejects.toThrow(/1024 dimensions/);
  });

  it('refuses a non-finite value', async () => {
    const v = embed(SKY);
    v[0] = Number.NaN;
    await expect(repo.retrieve(db.pool, { board: 'CBSE', embedding: v }))
      .rejects.toThrow(/non-finite/);
  });
});

describe('the editorial state machine', () => {
  it('draft() cannot publish, and has no argument that would let it', async () => {
    const body = `Unsigned fact ${RUN}.`;
    const id = await repo.draft(db.pool, {
      board: BOARD_ANY, subject: 'science', topic: `unsigned-${RUN}`,
      body, draftedBy: 'test', chunks: [{ body, embedding: embed(body) }],
    });
    const rows = await repo.listEntries(db.pool);
    const row = rows.find((r) => r.id === id)!;
    expect(row.state).toBe('draft');
    expect(row.signedBy).toBeNull();
  });

  it('sign() publishes, records the name, and is idempotent', async () => {
    const body = `Signable fact ${RUN}.`;
    const id = await repo.draft(db.pool, {
      board: BOARD_ANY, subject: 'science', topic: `signable-${RUN}`,
      body, draftedBy: 'test', chunks: [{ body, embedding: embed(body) }],
    });
    expect(await repo.sign(db.pool, id, 'first@tulifo.ai')).toBe(true);
    // A re-run must not overwrite the first signature with a later one.
    expect(await repo.sign(db.pool, id, 'second@tulifo.ai')).toBe(false);
    const row = (await repo.listEntries(db.pool)).find((r) => r.id === id)!;
    expect(row.state).toBe('published');
    expect(row.signedBy).toBe('first@tulifo.ai');
  });

  it('an entry with no chunk is refused — it could never be retrieved', async () => {
    await expect(repo.draft(db.pool, {
      board: BOARD_ANY, subject: 'science', topic: `empty-${RUN}`,
      body: 'x', draftedBy: 'test', chunks: [],
    })).rejects.toThrow(/at least one chunk/);
  });
});
