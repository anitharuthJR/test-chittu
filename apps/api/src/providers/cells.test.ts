/**
 * Routing config: what it may and may not do.
 *
 * `route()` is the one place a vendor is chosen (§12.3), which is what makes it
 * enforceable — and also what makes it dangerous to make configurable. These
 * tests pin the three properties that keep a config layer from becoming an
 * injection point.
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOGUE, resolveCells, promptVersionFor, cellFor,
} from './cells.js';
import { DEFAULT_CELLS } from './router.js';
import { CLASSIFIER_PROMPT_VERSION } from '@chittu/safety-kernel';
import { SANDBOX_PROMPT_VERSION } from '@chittu/pedagogy';

describe('the catalogue is a whitelist, not a suggestion', () => {
  it('every compiled default is itself in the catalogue', () => {
    for (const [category, cell] of Object.entries(DEFAULT_CELLS)) {
      expect(MODEL_CATALOGUE[cell.provider], `${category}: unknown provider`).toBeDefined();
      expect(MODEL_CATALOGUE[cell.provider], `${category}: model not catalogued`)
        .toContain(cell.model);
    }
  });

  it('config cannot introduce a model string that is not compiled in', () => {
    const r = resolveCells({
      env: { CHITTU_CELL_CLASSIFIER: 'anthropic:some-model-nobody-reviewed' },
    });
    expect(r.cells.classifier).toEqual(DEFAULT_CELLS.classifier);
    expect(r.problems.join(' ')).toMatch(/some-model-nobody-reviewed/);
  });

  it('config cannot introduce a provider that has no adapter', () => {
    const r = resolveCells({ env: { CHITTU_CELL_SANDBOX: 'openai:gpt-4' } });
    expect(r.cells.sandbox).toEqual(DEFAULT_CELLS.sandbox);
    expect(r.problems.join(' ')).toMatch(/openai/);
  });

  it('config cannot invent a category', () => {
    const r = resolveCells({ env: { CHITTU_CELL_NONSENSE: 'anthropic:claude-sonnet-5' } });
    expect(r.problems.join(' ')).toMatch(/NONSENSE/i);
  });
});

describe('promptVersion is never configurable', () => {
  it('comes from the code that owns the prompt, whatever config says', () => {
    const r = resolveCells({
      env: { CHITTU_CELL_CLASSIFIER: 'anthropic:claude-sonnet-5' },
    });
    // The model changed...
    expect(r.cells.classifier.model).toBe('claude-sonnet-5');
    // ...the prompt version did not, and cannot.
    expect(r.cells.classifier.promptVersion).toBe(CLASSIFIER_PROMPT_VERSION);
    expect(promptVersionFor('sandbox')).toBe(SANDBOX_PROMPT_VERSION);
  });

  it('a db row claiming a prompt version is ignored', () => {
    const r = resolveCells({
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5',
        promptVersion: 'totally-made-up' } as never],
    });
    expect(r.cells.sandbox.promptVersion).toBe(SANDBOX_PROMPT_VERSION);
  });
});

describe('precedence and origin', () => {
  it('db overrides env overrides the compiled default', () => {
    const r = resolveCells({
      env: { CHITTU_CELL_SANDBOX: 'anthropic:claude-haiku-4-5-20251001' },
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5' }],
    });
    expect(r.cells.sandbox.model).toBe('claude-opus-5');
    expect(r.origin.sandbox).toBe('db');
  });

  it('env is used when there is no db row', () => {
    const r = resolveCells({ env: { CHITTU_CELL_SANDBOX: 'anthropic:claude-opus-5' } });
    expect(r.cells.sandbox.model).toBe('claude-opus-5');
    expect(r.origin.sandbox).toBe('env');
  });

  it('untouched cells report themselves as defaults', () => {
    const r = resolveCells({});
    expect(r.origin.classifier).toBe('default');
    expect(r.cells).toEqual(DEFAULT_CELLS);
    expect(r.problems).toEqual([]);
  });

  it('CHITTU_ROUTING_DB=off pins a deployment against runtime changes', () => {
    const r = resolveCells({
      env: { CHITTU_ROUTING_DB: 'off', CHITTU_CELL_SANDBOX: 'anthropic:claude-haiku-4-5-20251001' },
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5' }],
    });
    expect(r.cells.sandbox.model).toBe('claude-haiku-4-5-20251001');
    expect(r.origin.sandbox).toBe('env');
    expect(r.dbIgnored).toBe(true);
  });
});

describe('bad config never fails open', () => {
  it('an unparseable value falls back to the default and is reported', () => {
    const r = resolveCells({ env: { CHITTU_CELL_SANDBOX: 'garbage-with-no-colon' } });
    expect(r.cells.sandbox).toEqual(DEFAULT_CELLS.sandbox);
    expect(r.problems).toHaveLength(1);
  });

  it('one bad cell does not poison the others', () => {
    const r = resolveCells({
      env: {
        CHITTU_CELL_SANDBOX: 'nonsense',
        CHITTU_CELL_CLASSIFIER: 'anthropic:claude-opus-5',
      },
    });
    expect(r.cells.sandbox).toEqual(DEFAULT_CELLS.sandbox);
    expect(r.cells.classifier.model).toBe('claude-opus-5');
  });

  it('strict mode refuses rather than silently running the default', () => {
    expect(() => resolveCells({ env: { CHITTU_CELL_SANDBOX: 'nope' }, strict: true }))
      .toThrow(/routing config/i);
  });

  it('strict mode is fine when the config is valid', () => {
    expect(() => resolveCells({
      env: { CHITTU_CELL_SANDBOX: 'anthropic:claude-opus-5' }, strict: true,
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Band and country. Added 2026-08-25.
// ---------------------------------------------------------------------------
describe('scoped cells — band and country', () => {
  const IN_THINKER = { band: 'thinker', country: 'IN' } as const;
  const GB_EXPLORER = { band: 'explorer', country: 'GB' } as const;

  it('an unscoped row still applies to everyone', () => {
    const r = resolveCells({
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5' }],
    });
    expect(cellFor(r, 'sandbox', IN_THINKER).model).toBe('claude-opus-5');
    expect(cellFor(r, 'sandbox', GB_EXPLORER).model).toBe('claude-opus-5');
  });

  it('a country-scoped row applies only in that country', () => {
    const r = resolveCells({
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'GB' }],
    });
    expect(cellFor(r, 'sandbox', GB_EXPLORER).model).toBe('claude-opus-5');
    expect(cellFor(r, 'sandbox', IN_THINKER)).toEqual(DEFAULT_CELLS.sandbox);
  });

  it('a band-scoped row applies only to that band', () => {
    const r = resolveCells({
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', band: 'explorer' }],
    });
    expect(cellFor(r, 'sandbox', GB_EXPLORER).model).toBe('claude-haiku-4-5-20251001');
    expect(cellFor(r, 'sandbox', IN_THINKER)).toEqual(DEFAULT_CELLS.sandbox);
  });

  it('country beats band, because residency is a legal constraint and band is a preference', () => {
    const r = resolveCells({
      rows: [
        { category: 'sandbox', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', band: 'thinker' },
        { category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'IN' },
      ],
    });
    expect(cellFor(r, 'sandbox', IN_THINKER).model).toBe('claude-opus-5');
  });

  it('the most specific row wins over both', () => {
    const r = resolveCells({
      rows: [
        { category: 'sandbox', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        { category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'IN' },
        { category: 'sandbox', provider: 'anthropic', model: 'claude-sonnet-5', country: 'IN', band: 'thinker' },
      ],
    });
    expect(cellFor(r, 'sandbox', IN_THINKER).model).toBe('claude-sonnet-5');
    expect(cellFor(r, 'sandbox', { band: 'explorer', country: 'IN' }).model).toBe('claude-opus-5');
    expect(cellFor(r, 'sandbox', GB_EXPLORER).model).toBe('claude-haiku-4-5-20251001');
  });

  it('no context falls back to the unscoped assignment', () => {
    const r = resolveCells({
      rows: [
        { category: 'sandbox', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
        { category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'IN' },
      ],
    });
    expect(cellFor(r, 'sandbox', undefined).model).toBe('claude-haiku-4-5-20251001');
  });

  it('a scoped row still cannot introduce an uncatalogued model', () => {
    const r = resolveCells({
      rows: [{ category: 'sandbox', provider: 'anthropic', model: 'not-a-model', country: 'IN' }],
    });
    expect(cellFor(r, 'sandbox', IN_THINKER)).toEqual(DEFAULT_CELLS.sandbox);
    expect(r.problems.join(' ')).toMatch(/not-a-model/);
  });

  it('an unknown band or country is rejected, not silently scoped to nothing', () => {
    const r = resolveCells({
      rows: [
        { category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', country: 'ZZ' },
        { category: 'sandbox', provider: 'anthropic', model: 'claude-opus-5', band: 'wizard' },
      ],
    });
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join(' ')).toMatch(/ZZ/);
    expect(r.problems.join(' ')).toMatch(/wizard/);
  });

  it('env scoping: CHITTU_CELL_SANDBOX_GB and _GB_THINKER', () => {
    const r = resolveCells({
      env: {
        CHITTU_CELL_SANDBOX_GB: 'anthropic:claude-opus-5',
        CHITTU_CELL_SANDBOX_GB_THINKER: 'anthropic:claude-sonnet-5',
      },
    });
    expect(cellFor(r, 'sandbox', GB_EXPLORER).model).toBe('claude-opus-5');
    expect(cellFor(r, 'sandbox', { band: 'thinker', country: 'GB' }).model).toBe('claude-sonnet-5');
    expect(cellFor(r, 'sandbox', IN_THINKER)).toEqual(DEFAULT_CELLS.sandbox);
  });
});

// ---------------------------------------------------------------------------
// Reading provider_cell. Append-only, so "current" means newest per category.
// ---------------------------------------------------------------------------
import { beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '@chittu/db';
import { readCells } from './cells.js';

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

async function put(category: string, provider: string, model: string, by = 'ops-arun') {
  await db.pool.query(
    `INSERT INTO provider_cell (category, provider, model, changed_by, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [category, provider, model, by, 'routing change under test']);
}

describe('readCells', () => {
  it('returns nothing when the table is empty', async () => {
    expect(await readCells(db.pool)).toEqual([]);
  });

  it('returns the NEWEST row per category, not every row', async () => {
    await put('sandbox', 'anthropic', 'claude-haiku-4-5-20251001');
    await new Promise((r) => setTimeout(r, 5));
    await put('sandbox', 'anthropic', 'claude-opus-5');

    const rows = await readCells(db.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'sandbox', model: 'claude-opus-5' });
  });

  it('keeps categories independent', async () => {
    await put('classifier', 'anthropic', 'claude-sonnet-5');
    const rows = await readCells(db.pool);
    expect(rows.map((r) => r.category).sort()).toEqual(['classifier', 'sandbox']);
  });

  it('feeds resolveCells, which is the only reason it exists', async () => {
    const r = resolveCells({ rows: await readCells(db.pool) });
    expect(r.cells.sandbox.model).toBe('claude-opus-5');
    expect(r.cells.classifier.model).toBe('claude-sonnet-5');
    expect(r.origin.sandbox).toBe('db');
    expect(r.problems).toEqual([]);
  });

  it('the schema refuses a routing change nobody signed', async () => {
    await expect(db.pool.query(
      `INSERT INTO provider_cell (category, provider, model, changed_by, reason)
       VALUES ('sandbox','anthropic','claude-opus-5','','no reason given')`))
      .rejects.toThrow(/cell_changed_by_named|check/i);
  });

  it('the schema refuses an unexplained routing change', async () => {
    await expect(db.pool.query(
      `INSERT INTO provider_cell (category, provider, model, changed_by, reason)
       VALUES ('sandbox','anthropic','claude-opus-5','ops-arun','x')`))
      .rejects.toThrow(/cell_reason_meaningful|check/i);
  });

  it('the schema refuses a category that is not a routing category', async () => {
    await expect(db.pool.query(
      `INSERT INTO provider_cell (category, provider, model, changed_by, reason)
       VALUES ('nonsense','anthropic','claude-opus-5','ops-arun','a good reason here')`))
      .rejects.toThrow(/cell_category|check/i);
  });

  it('a database that is unreachable does not take routing down', async () => {
    // The compiled defaults are the floor, exactly as the helpline REGISTRY is.
    const broken = { query: () => Promise.reject(new Error('connection refused')) } as never;
    expect(await readCells(broken)).toEqual([]);
  });
});
