/**
 * The dev proxy target must track the API's actual port, not assume :8080.
 *
 * dev.sh exports PORT before launching either dev server — `API_PORT="${PORT:-
 * 8080}"` for the API, and (unlike WEB_PORT, which is passed as a `vite --port`
 * flag) the web dev server gets no explicit override, so it inherits the SAME
 * `PORT` from the shell that ran `pnpm start`. Once #51 made a non-default
 * PORT the normal case for parallel worktrees rather than the exception, a
 * proxy hardcoded to :8080 stopped matching the API dev server vite sits next
 * to — every `/v1/*` and `/health` request failed with ECONNREFUSED, and the
 * browser never got past the consent screen: ports differ, so nothing behind
 * them ever looked broken to a test that only hits the API directly.
 *
 * Run through a plain `node` child process rather than importing vite.config.ts
 * in-process: this file's own vitest project runs under jsdom, and loading a
 * SECOND vite config there drags vite's esbuild transform into the jsdom
 * globals, which fails its own environment sanity check ("TextEncoder().encode
 * ("") instanceof Uint8Array is incorrectly false") before the config is ever
 * evaluated. A plain Node child sidesteps that — and is how vite's own CLI
 * loads this file for real, so it is the more faithful check, not a fallback.
 * No `tsx` needed either: Node 25's native type-stripping reads a config this
 * simple (annotations only, nothing erasure can't handle) with no dependency
 * beyond `node` itself.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CONFIG_PATH = here('../vite.config.ts');

function proxyFor(port: string | undefined): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (port === undefined) delete env['PORT'];
  else env['PORT'] = port;

  const script = `
    const mod = await import(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify(mod.default.server.proxy));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: here('..'),
    env,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

describe('the vite dev proxy targets the real API port', () => {
  it('defaults to :8080, matching apps/api/src/main.ts default and dev.sh', () => {
    const proxy = proxyFor(undefined);
    expect(proxy['/v1']).toBe('http://localhost:8080');
    expect(proxy['/health']).toBe('http://localhost:8080');
  });

  it('follows PORT — the same variable dev.sh reads into API_PORT', () => {
    const proxy = proxyFor('8101');
    expect(proxy['/v1']).toBe('http://localhost:8101');
    expect(proxy['/health']).toBe('http://localhost:8101');
  });

  it('is never a bare 8080 string once PORT is set — that was the whole bug', () => {
    const proxy = proxyFor('19999');
    expect(proxy['/v1']).not.toBe('http://localhost:8080');
  });
});
