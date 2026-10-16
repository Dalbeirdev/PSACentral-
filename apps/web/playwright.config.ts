import { defineConfig, devices } from '@playwright/test';
import { E2E_API_PORT, E2E_BASE_URL, E2E_WEB_PORT, e2eApiEnv } from './e2e/env';

/**
 * End-to-end tests run against a dedicated stack: API on :4310 backed by the isolated
 * psacc_e2e database (reset + seeded in global setup) and a production build of the web app
 * on :3310. Browser: the locally installed Microsoft Edge (Chromium) via the msedge channel.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    channel: 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1440, height: 900 } }, testIgnore: /responsive\.spec/ },
    { name: 'mobile', use: { channel: 'msedge', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, testMatch: /responsive\.spec/ },
  ],
  webServer: [
    {
      command: 'pnpm --filter @psacc/api exec tsx src/main.ts',
      url: `http://127.0.0.1:${E2E_API_PORT}/api/v1/health/live`,
      env: e2eApiEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `pnpm exec next build && pnpm exec next start --port ${E2E_WEB_PORT} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${E2E_WEB_PORT}/login`,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${E2E_API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
