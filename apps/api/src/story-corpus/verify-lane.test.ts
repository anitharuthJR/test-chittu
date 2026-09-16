/**
 * Pins the `story kit` lane in scripts/verify.sh: gated on the env EXISTING (not on uv —
 * a bare `uv run` would sync the env and download torch mid-verify), runs
 * `python -m pytest` (so the tree is on sys.path), and says so when it skips.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const VERIFY = readFileSync(new URL('../../../../scripts/verify.sh', import.meta.url), 'utf8');

describe('pnpm verify — the story kit lane', () => {
  it('exists and is gated on the env, not on uv', () => {
    expect(VERIFY).toMatch(/step "story kit"/);
    expect(VERIFY).toMatch(/\[ -x llm-kit\/nanochat\/\.venv\/bin\/python \]/);
    expect(VERIFY).toMatch(/uv run --no-sync python -m pytest -q chittu/);
  });
  it('says so when it skips', () => {
    expect(VERIFY).toMatch(/SKIPPED: story kit env not set up/);
  });
});
