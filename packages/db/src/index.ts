export * from './client.js';
export * from './crypto.js';
export * from './audit-repo.js';
export * from './consent-repo.js';
export * from './child-repo.js';

/**
 * The test fixture is exported from the main entry point on purpose: PGlite is
 * imported DYNAMICALLY inside it, so nothing pulls a WASM Postgres into a
 * production bundle unless a test actually calls createTestDb().
 */
export * from './testing.js';

export * from './helpline-repo.js';
