import { defineConfig, devices } from '@playwright/test';

const appUrl = process.env.E2E_APP_URL;
if (appUrl && !process.env.E2E_BACKEND_URL) throw new Error('E2E_APP_URL and E2E_BACKEND_URL are both needed for hosted runs');

export default defineConfig({
  testDir: '.',
  globalTeardown: appUrl ? undefined : './global-teardown.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: appUrl || 'http://localhost:8099', trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: appUrl ? undefined : [
    {
      command: 'bash e2e/store/start.sh', cwd: '..',
      url: 'http://localhost:9100/health', timeout: 600_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'EXPO_PUBLIC_MEDUSA_URL=http://localhost:9100 EXPO_PUBLIC_E2E_DEBUG=1 CI=1 EXPO_NO_TELEMETRY=1 pnpm --filter @medusapos/expo build:web --clear && node e2e/serve.mjs',
      cwd: '..', url: 'http://localhost:8099', timeout: 300_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
