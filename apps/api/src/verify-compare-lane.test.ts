import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = readFileSync(join(HERE, '..', '..', '..', 'scripts', 'verify.sh'), 'utf8');

describe('the compare-kit verify lane', () => {
  it('exists and runs the kit\'s tests under uv', () => {
    expect(VERIFY).toContain('step "compare kit"');
    expect(VERIFY).toMatch(/cd llm-kit\/compare && uv run --frozen python -m pytest -q/);
  });
  it('is gated on the env existing and says SKIPPED otherwise, like the story kit lane', () => {
    expect(VERIFY).toContain('if [ -x llm-kit/compare/.venv/bin/python ]');
    expect(VERIFY).toMatch(/SKIPPED: compare kit env not set up \(cd llm-kit\/compare && uv sync --frozen --group dev\) — its tests did not run/);
  });
});
