/**
 * `PipelinePorts.ground`, assembled from an embedder and the corpus repo.
 *
 * ---------------------------------------------------------------------------
 * IT TAKES A `tx` AND IT MUST
 *
 * `runTurn` is called inside `store.withChild(...)` (server.ts). CLAUDE.md
 * records reading from `pool` inside that transaction happening TWICE, and the
 * reason it keeps happening is that it does not look like anything: the read
 * returns the right rows and the tests stay green.
 *
 * It is quieter here than in the cases that produced the rule. The corpus is
 * editorial content, not child data, so `assert_child_scope()` has no opinion
 * on it and nothing RAISEs. What you get instead is a read on a second
 * connection while the turn's transaction is open — a lock-ordering hazard for
 * free, and a read that cannot see anything the turn has written. So the
 * factory takes the transaction per call rather than closing over a pool, and
 * there is no overload that omits it.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT NARROW BY SUBJECT, DELIBERATELY
 *
 * `retrieve` can, and the repo test proves it does. This caller passes null.
 *
 * `detectSubject` is a substring match over seven patterns and returns null
 * often — "what is a fraction" names no subject in the union at all, because
 * arithmetic never reaches a model and pedagogy therefore has no maths
 * subject. Narrowing on that would mean a subject MISDETECTION silently
 * removes a correct fact from consideration, and the child gets "I'm not
 * totally sure" about something the corpus knows. That failure is invisible in
 * every trace: it reads as an ordinary CORPUS MISS.
 *
 * At fifteen entries the ANN ordering plus the distance floor discriminate
 * perfectly well without it. When the corpus is large enough that they do not,
 * subject narrowing is the knob — and turning it must come with a test proving
 * a misdetected subject cannot hide a hit, because that is the whole risk.
 */

import type { Db } from '@chittu/db';
import { corpusRepo, type CorpusRepo } from '@chittu/db';
import type { GroundingQuery } from '@chittu/pipeline';
import type { RouteContext, UsageSink } from '@chittu/contracts';
import type { Embedder } from './embed.js';

export interface GroundingDeps {
  readonly repo: CorpusRepo;
  readonly embed: Embedder;
  /** The turn's transaction. Never a pool — see the header. */
  readonly tx: Db;
  /**
   * The band and country of the turn being grounded.
   *
   * Carried because embedding a child's turn shows a provider that child's
   * words, so it is a call `provider_clearance` governs — per country, like
   * every other. It is not optional: a caller that cannot name the market has
   * no business sending the turn anywhere.
   */
  readonly ctx: RouteContext;
  /** Metering, so an embedding call is visible on the ops console. */
  readonly onUsage?: UsageSink;
}

/**
 * Throws on any failure, which is the contract `PipelinePorts.ground` states:
 * the pipeline turns a throw into CORPUS UNAVAILABLE and the truth wall, and a
 * caught-and-nulled failure here would arrive as CORPUS MISS — a claim that
 * the corpus was consulted and had nothing, which would be false.
 */
export async function ground(deps: GroundingDeps, q: GroundingQuery): Promise<string | null> {
  const embedding = await deps.embed(q.text, deps.ctx, deps.onUsage);
  const hits = await deps.repo.retrieve(deps.tx, {
    board: q.board,
    embedding,
    subject: null,
    limit: 1,
  });
  return hits[0]?.body ?? null;
}

/**
 * Curried for the call site: the pool-bound repo is built once at boot, the
 * transaction arrives per turn.
 */
export function groundingPort(pool: Parameters<typeof corpusRepo>[0], embed: Embedder) {
  const repo = corpusRepo(pool);
  return (tx: Db, ctx: RouteContext, onUsage?: UsageSink) =>
    (q: GroundingQuery) => ground(
      { repo, embed, tx, ctx, ...(onUsage === undefined ? {} : { onUsage }) }, q);
}
