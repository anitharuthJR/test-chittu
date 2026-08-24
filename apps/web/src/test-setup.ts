import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

afterEach(cleanup);

/**
 * A real `Storage`, because jsdom's is not one here.
 *
 * Under this Vitest/jsdom combination `globalThis.localStorage` resolves
 * through a getter to a plain `{}` with no `getItem` — even with an explicit
 * `http://localhost/` origin. The store guards every storage call in a
 * try/catch (correct: private mode and quota errors are real), which means
 * without this shim every read and write would throw, be swallowed, and the
 * persistence tests would pass while proving nothing.
 *
 * This is a test-environment repair, not a production polyfill. Browsers ship
 * the real thing.
 */
class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  get length(): number { return this.#map.size; }
  clear(): void { this.#map.clear(); }
  getItem(k: string): string | null { return this.#map.get(k) ?? null; }
  key(i: number): string | null { return [...this.#map.keys()][i] ?? null; }
  removeItem(k: string): void { this.#map.delete(k); }
  setItem(k: string, v: string): void { this.#map.set(k, String(v)); }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as Record<string, unknown>)[name];
  if (existing === undefined || typeof (existing as Storage).getItem !== 'function') {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(), writable: true, configurable: true,
    });
  }
}

/**
 * Speech APIs are left undefined on purpose. The client capability-detects both
 * (§4.3: hide the mic where ASR is unavailable and say so, rather than showing a
 * button that does nothing), so "absent" is the honest default and a test that
 * wants voice present installs its own stub.
 */
