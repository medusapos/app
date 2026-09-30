import { defineConfig, devices } from '@playwright/test';
import { E2E_RUN, isCI } from '../ports';

const backendUrl = `http://localhost:${E2E_RUN.backendPort}`;

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  globalTeardown: '../global-teardown.ts',
  workers: 1,
  expect: { timeout: 30_000 },
  reporter: isCI() ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${E2E_RUN.appPort}`, trace: isCI() ? 'retain-on-failure' : 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bash e2e/store/start.sh', cwd: '../..',
    url: `${backendUrl}/health`, timeout: 600_000,
    reuseExistingServer: !isCI() && process.env.E2E_REUSE === '1',
    env: {
      E2E_BACKEND_PORT: String(E2E_RUN.backendPort),
      E2E_APP_PORT: String(E2E_RUN.appPort),
      E2E_DATABASE: E2E_RUN.database,
    },
  },
});
