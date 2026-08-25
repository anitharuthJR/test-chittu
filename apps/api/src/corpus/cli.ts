/**
 * Ops commands for the grounded corpus.
 *
 *   pnpm --filter @chittu/api exec tsx src/corpus/cli.ts list
 *   pnpm --filter @chittu/api exec tsx src/corpus/cli.ts import you@tulifo.ai
 *   pnpm --filter @chittu/api exec tsx src/corpus/cli.ts sign <entry-id> you@tulifo.ai
 *   pnpm --filter @chittu/api exec tsx src/corpus/cli.ts search "why is the sky blue"
 *
 * `import` NEEDS THE EMBEDDER UP. `corpus_chunk.embedding` is NOT NULL, so
 * there is no way to land a row now and embed it later — which is the right
 * constraint: a chunk with no vector is a chunk that can never be retrieved,
 * and a corpus full of those looks identical to a corpus that is simply thin.
 *
 * `import` TAKES A NAME, and the name is not decoration. It goes into
 * `signed_by`, which is what `published_must_be_signed` exists to require, and
 * it is the answer to "who says these fifteen facts are true". A script cannot
 * be that answer. See seed-data.ts for why these particular fifteen can be
 * signed at import at all, and why nothing added later can be.
 */

import { corpusRepo, BOARD_ANY } from '@chittu/db';
import type { Country } from '@chittu/contracts';
import { bootstrapDb } from '../db-bootstrap.js';
import { localAdapter } from '../providers/local.js';
import { createRouter } from '../providers/router.js';
import { embedderFor, type Embedder } from './embed.js';
import { SEED_ENTRIES, SEED_BOARD, SEED_EMBED_MODEL } from './seed-data.js';

/**
 * The CLI builds its own router rather than reading an embedder out of the
 * environment, so that `import` embeds through exactly the path a turn does —
 * same cell, same model, same adapter. An import that used a different route
 * from the one retrieval uses would produce a corpus embedded in one vector
 * space and queried in another, which is the failure no check can see.
 *
 * CLEARANCE IS NOT ENFORCED HERE, and that is correct rather than convenient:
 * this is an operator embedding editorial content that was written for
 * publication. No child's words are involved, so `provider_clearance` — which
 * governs showing a vendor a CHILD's text — has nothing to say about it.
 */
function requireEmbedder(): Embedder {
  const baseUrl = process.env['CHITTU_LOCAL_BASE_URL'] ?? '';
  if (baseUrl === '') {
    console.error(
      'No embedder: set CHITTU_LOCAL_BASE_URL (e.g. http://127.0.0.1:11434/v1).\n'
      + `The corpus is embedded with ${SEED_EMBED_MODEL}; if you point the embedding\n`
      + 'cell at another model, re-embed EVERYTHING — vectors from two different\n'
      + 'models in one table retrieve confident nonsense and nothing will complain.');
    process.exit(1);
  }
  const router = createRouter({ adapters: { local: localAdapter({ baseUrl }) } });
  const embed = embedderFor(router);
  if (embed === null) {
    console.error('the router built here cannot embed — this is a bug, not a config error');
    process.exit(1);
  }
  return embed;
}

/** Any enabled market; clearance is not consulted for editorial content. */
const OPS_CTX = { band: 'builder', country: 'IN' as Country } as const;

async function importSeed(signer: string): Promise<void> {
  if (!signer || !signer.includes('@')) {
    console.error('usage: cli.ts import <you@tulifo.ai>');
    console.error('A person signs the corpus, not a script. See seed-data.ts.');
    process.exit(1);
  }
  const embed = requireEmbedder();
  const { pool } = await bootstrapDb();
  const repo = corpusRepo(pool);
  let added = 0;
  let skipped = 0;

  for (const entry of SEED_ENTRIES) {
    const existing = await repo.findByTopic(pool, SEED_BOARD, entry.topic);
    if (existing !== null) {
      skipped += 1;
      continue;
    }
    // Embed the BODY, which is also what is chunked. One chunk per entry: these
    // are single sentences, and splitting a sentence would produce fragments
    // that retrieve well and read as truncated facts.
    const embedding = await embed(entry.body, OPS_CTX);
    const id = await repo.draft(pool, {
      board: SEED_BOARD,
      subject: entry.subject,
      topic: entry.topic,
      body: entry.body,
      sourceUrl: 'prototype/chittu-v3.html:474',
      draftedBy: 'prototype-v3.3',
      chunks: [{ body: entry.body, embedding }],
    });
    await repo.sign(pool, id, signer);
    added += 1;
  }

  console.log(`imported ${added}, already present ${skipped} (board ${SEED_BOARD})`);
  console.log(`signed by ${signer}, embedded with ${SEED_EMBED_MODEL}`);
  await pool.close();
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'import') return importSeed(args[0] ?? '');

  const { pool } = await bootstrapDb();
  const repo = corpusRepo(pool);

  switch (cmd) {
    case 'list': {
      const rows = await repo.listEntries(pool);
      for (const r of rows) {
        const sig = r.signedBy ? ` signed:${r.signedBy}` : '';
        console.log(`${r.state.padEnd(10)} ${r.board.padEnd(6)} ${r.subject.padEnd(9)} `
          + `${r.topic.padEnd(26)} ${r.chunks} chunk(s)${sig}`);
      }
      console.log(`\n${rows.length} entries; only 'published' is ever retrieved.`);
      break;
    }
    case 'sign': {
      const [id, signer] = args;
      if (!id || !signer) {
        console.error('usage: cli.ts sign <entry-id> <you@tulifo.ai>');
        process.exitCode = 1;
        break;
      }
      const ok = await repo.sign(pool, id, signer);
      console.log(ok ? `published ${id}, signed by ${signer}`
        : `no change — ${id} is already published, retired, or unknown`);
      break;
    }
    case 'search': {
      const q = args.join(' ');
      if (!q) {
        console.error('usage: cli.ts search "<what a child might ask>"');
        process.exitCode = 1;
        break;
      }
      const embed = requireEmbedder();
      // BOARD_ANY: the seed is board-agnostic, so this searches everything a
      // child on any board could reach. A board-scoped search is worth adding
      // when there is board-specific content to scope to.
      const hits = await repo.retrieve(pool, {
        board: BOARD_ANY,
        embedding: await embed(q, OPS_CTX),
      });
      if (hits.length === 0) {
        console.log('MISS — nothing within the distance floor. The truth wall answers this one.');
      }
      for (const h of hits) {
        console.log(`${h.distance.toFixed(4)}  ${h.topic}\n          ${h.body}`);
      }
      break;
    }
    default:
      console.error('commands: list | import <signer> | sign <id> <signer> | search <text>');
      process.exitCode = 1;
  }
  await pool.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
