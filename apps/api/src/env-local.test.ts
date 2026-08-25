/**
 * `.env.local` — a developer convenience with two safety obligations.
 *
 * It must never run in production (an image that reads a credential file is an
 * image that can bake one), and it must never OVERRIDE the real environment —
 * `ANTHROPIC_API_KEY=… pnpm start` has to keep meaning what it says, or the
 * banner and the router disagree about which key is in play.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvLocal, envLocalPath } from './env-local.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chittu-env-'));
  file = join(dir, '.env.local');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const load = (contents: string, env: NodeJS.ProcessEnv) => {
  writeFileSync(file, contents);
  return loadEnvLocal({ file, env });
};

/**
 * `pnpm start` runs from the repo root; `pnpm --filter @chittu/api dev` runs
 * from apps/api. A cwd-relative default would find the file in one and silently
 * not in the other, which looks exactly like "the key does not work".
 */
describe('envLocalPath', () => {
  it('resolves to the repo root, not the current working directory', () => {
    const p = envLocalPath();
    expect(p.endsWith('/.env.local')).toBe(true);
    // The repo root is the directory holding pnpm-workspace.yaml.
    const root = p.slice(0, -'/.env.local'.length);
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('loadEnvLocal', () => {
  it('sets a variable and reports its name', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(load('ANTHROPIC_API_KEY=sk-ant-xyz\n', env)).toEqual(['ANTHROPIC_API_KEY']);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-xyz');
  });

  /**
   * The shell wins. Anything else means `FOO=bar pnpm start` silently runs with
   * a different FOO than the one the operator typed.
   */
  it('never overrides a variable that is already set', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'from-shell' };
    expect(load('ANTHROPIC_API_KEY=from-file\n', env)).toEqual([]);
    expect(env['ANTHROPIC_API_KEY']).toBe('from-shell');
  });

  it('refuses to read anything in production', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    expect(load('ANTHROPIC_API_KEY=sk-ant-xyz\n', env)).toEqual([]);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('is a no-op when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvLocal({ file: join(dir, 'absent'), env })).toEqual([]);
  });

  it('skips comments and blank lines', () => {
    const env: NodeJS.ProcessEnv = {};
    const names = load('# a comment\n\n  # indented\nA=1\n', env);
    expect(names).toEqual(['A']);
    expect(env['A']).toBe('1');
  });

  /**
   * A pasted key with surrounding quotes or a trailing space produces a 401 that
   * looks like a bad key rather than a bad paste, so both are handled.
   */
  it('strips matched surrounding quotes', () => {
    const env: NodeJS.ProcessEnv = {};
    load('A="dq"\nB=\'sq\'\n', env);
    expect(env['A']).toBe('dq');
    expect(env['B']).toBe('sq');
  });

  it('trims incidental whitespace around an unquoted value', () => {
    const env: NodeJS.ProcessEnv = {};
    load('A =  spaced  \n', env);
    expect(env['A']).toBe('spaced');
  });

  it('preserves whitespace inside quotes', () => {
    const env: NodeJS.ProcessEnv = {};
    load('A="  padded  "\n', env);
    expect(env['A']).toBe('  padded  ');
  });

  it('tolerates a pasted `export` prefix', () => {
    const env: NodeJS.ProcessEnv = {};
    load('export A=1\n', env);
    expect(env['A']).toBe('1');
  });

  it('keeps everything after the first = , so a value may contain one', () => {
    const env: NodeJS.ProcessEnv = {};
    load('DATABASE_URL=postgres://u:p@h:5432/d?x=1\n', env);
    expect(env['DATABASE_URL']).toBe('postgres://u:p@h:5432/d?x=1');
  });

  it('ignores a line with no = rather than throwing', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(load('nonsense\nA=1\n', env)).toEqual(['A']);
  });

  /** Names only. A loader that logged values would put a key in the terminal. */
  it('returns names, never values', () => {
    const env: NodeJS.ProcessEnv = {};
    const names = load('SECRET=hunter2\n', env);
    expect(names).toEqual(['SECRET']);
    expect(JSON.stringify(names)).not.toContain('hunter2');
  });
});
