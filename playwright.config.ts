import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'corepack pnpm exec tsx tests/e2e/server.ts',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    timeout: 20_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
