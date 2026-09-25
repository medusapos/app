import { defineConfig, devices } from '@playwright/test';
import { E2E_RUN } from './ports';

const appUrl = process.env.E2E_APP_URL;
if (appUrl && !process.env.E2E_BACKEND_URL) throw new Error('E2E_APP_URL and E2E_BACKEND_URL are both needed for hosted runs');

const backendUrl = `http://localhost:${E2E_RUN.backendPort}`;
const appLocalUrl = `http://localhost:${E2E_RUN.appPort}`;

export default defineConfig({
  testDir: '.',
  globalTeardown: appUrl ? undefined : './global-teardown.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: appUrl || appLocalUrl, trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Outside CI, reuse only stays valid within this same checkout: the derived ports and
  // database below are unique to it, so a reused server is always this checkout's own.
  webServer: appUrl ? undefined : [
    {
      command: 'bash e2e/store/start.sh', cwd: '..',
      url: `${backendUrl}/health`, timeout: 600_000,
      reuseExistingServer: !process.env.CI,
      env: {
        E2E_BACKEND_PORT: String(E2E_RUN.backendPort),
        E2E_APP_PORT: String(E2E_RUN.appPort),
        E2E_DATABASE: E2E_RUN.database,
      },
    },
    {
      command: `EXPO_PUBLIC_MEDUSA_URL=${backendUrl} EXPO_PUBLIC_E2E_DEBUG=1 CI=1 EXPO_NO_TELEMETRY=1 pnpm --filter @medusapos/expo build:web --clear && node e2e/serve.mjs`,
      cwd: '..', url: appLocalUrl, timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env: { E2E_APP_PORT: String(E2E_RUN.appPort) },
    },
  ],
});
