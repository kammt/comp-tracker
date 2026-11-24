import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests',
  // The mock server keeps separate data per test, so even tests in one file run in parallel.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    // CI sets this to "chrome" to use the Google Chrome its runners come with, which saves
    // downloading a browser on every run. Locally the default is Playwright's own Chromium.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 390, height: 844 },
    // The app's offline cache would otherwise sit between the tests and the mock server.
    serviceWorkers: 'block',
    // The app skips its animations then, so clicks don't wait for dialogs and pages to settle.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/mock-server.mjs',
    url: `http://localhost:${PORT}/index.html`,
    env: { PORT: String(PORT) },
    // Always a fresh server: one left running (or another app on the port) could serve stale responses.
    reuseExistingServer: false,
  },
});
