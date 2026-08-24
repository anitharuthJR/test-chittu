/**
 * Two projects, because the client needs jsdom and a JSX transform and the
 * server must not have either. `pnpm test` runs both.
 */
export default ['./vitest.config.ts', './apps/web/vitest.config.ts'];
