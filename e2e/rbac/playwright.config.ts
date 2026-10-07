import { defineConfig, devices } from '@playwright/test';
import { E2E_RUN, isCI } from '../ports';

const backendUrl = `http://localhost:${E2E_RUN.backendPort}`;
const appLocalUrl = `http://localhost:${E2E_RUN.appPort}`;

// ADR 0023: the e2e store with Medusa RBAC on (E2E_RBAC=1 in e2e/store/start.sh), on the same ports and
// database as e2e/playwright.config.ts, so the two runs go one after the other, never at once.
export default defineConfig({
  testDir: '.',
  globalTeardown: '../global-teardown.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: isCI() ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: appLocalUrl, trace: isCI() ? 'retain-on-failure' : 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'bash e2e/store/start.sh', cwd: '../..',
      url: `${backendUrl}/health`, timeout: 600_000,
      reuseExistingServer: !isCI() && process.env.E2E_REUSE === '1',
      env: {
        E2E_BACKEND_PORT: String(E2E_RUN.backendPort),
        E2E_APP_PORT: String(E2E_RUN.appPort),
        E2E_DATABASE: E2E_RUN.database,
        E2E_RBAC: '1',
      },
    },
    {
      command: `EXPO_PUBLIC_MEDUSA_URL=${backendUrl} EXPO_PUBLIC_E2E_DEBUG=1 EXPO_PUBLIC_DEMO=1 CI=1 EXPO_NO_TELEMETRY=1 pnpm --filter @medusapos/expo build:web --clear && node e2e/serve.mjs`,
      cwd: '../..', url: appLocalUrl, timeout: 300_000,
      reuseExistingServer: !isCI() && process.env.E2E_REUSE === '1',
      env: { E2E_APP_PORT: String(E2E_RUN.appPort) },
    },
  ],
});
