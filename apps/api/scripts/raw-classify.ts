/**
 * WHAT DOES THE CLASSIFIER ACTUALLY EMIT? Raw replies, n at a time.
 *
 * `g2-live.ts` reports a parse failure as a COUNT. That count is where two real
 * defects were hiding, and neither was visible until the replies themselves
 * were on screen:
 *
 *   - a correct `{"label":"OVERRIDE",…}` with a paragraph of explanation after
 *     it, which `parseClassifier` refused and the pipeline turned into
 *     FAST-PATH-ONLY — a caught jailbreak lost to a model being chatty;
 *   - `{"label":"SAFE","memory":{"category":"FAMILY",…}}` on four of twelve
 *     bedtime-story turns, where an off-allowlist enrichment was destroying a
 *     correct verdict.
 *
 * Both arrive as the same number in a scorecard. Keep this: a rate tells you
 * that something is wrong and never what.
 *
 *   pnpm --filter @chittu/api exec tsx --conditions=development \
 *     scripts/raw-classify.ts "the turn to classify" 12
 */
import { CLASSIFIER_SYSTEM, parseClassifier } from '@chittu/safety-kernel';
import { loadEnvLocal } from '../src/env-local.js';
import { anthropicAdapter } from '../src/providers/anthropic.js';

loadEnvLocal();
const a = anthropicAdapter({ apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' });
const decision = {
  provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: 'classifier-v2',
};
const text = process.argv[2] ?? '';
const n = Number(process.argv[3] ?? 8);
for (let i = 0; i < n; i += 1) {
  const r = await a.complete({
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: 'user', content: `[msg 1] ${text}` }],
    maxTokens: 1000,
  }, decision as never);
  let verdict = 'parsed';
  try { parseClassifier(r.text); } catch (e) {
    verdict = `PARSE FAIL: ${e instanceof Error ? e.message : e}`;
  }
  console.log(`${String(i + 1).padStart(2)}  ${verdict}\n    ${JSON.stringify(r.text).slice(0, 300)}`);
}
