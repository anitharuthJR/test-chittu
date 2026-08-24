// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * The prototype is a single file with no build step and no server, so tests load
 * it over file:// and intercept the Anthropic calls with page.route(). Nothing
 * here reaches the network — every model response in these tests is a stub.
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    // Deterministic viewport so block-rendering assertions are stable.
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
