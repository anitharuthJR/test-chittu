export * from './client.js';
export * from './crypto.js';
export * from './audit-repo.js';
export * from './consent-repo.js';
export * from './child-repo.js';

/**
 * The test fixture ships from the main entry point. It used to carry a caveat —
 * PGlite was imported dynamically inside it so a WASM Postgres could not reach a
 * production bundle — which no longer applies: createTestDb() now opens an
 * ordinary node-postgres pool against DATABASE_URL, the same driver the runtime
 * uses, and pulls in nothing the runtime does not already have.
 */
export * from './testing.js';

export * from './helpline-repo.js';
export * from './engagement-repo.js';
export * from './metering-repo.js';
export * from './signal-repo.js';
