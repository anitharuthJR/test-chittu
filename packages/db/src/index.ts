export * from './client';
export * from './crypto';
export * from './audit-repo';
export * from './consent-repo';
export * from './child-repo';

/**
 * The test fixture is exported from the main entry point on purpose: PGlite is
 * imported DYNAMICALLY inside it, so nothing pulls a WASM Postgres into a
 * production bundle unless a test actually calls createTestDb().
 */
export * from './testing';
