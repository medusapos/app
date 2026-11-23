import path from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// The capture shoots the throwaway local store only, never the shared demo. (Imports run first; the main config
// refuses E2E_APP_URL alone itself.)
if (process.env.E2E_APP_URL || process.env.E2E_BACKEND_URL) throw new Error('capture runs only against the local e2e store');

// The main config's teardown and webServer cwd are relative to e2e/; Playwright resolves them against this file's folder.
const root = path.resolve(__dirname, '../..');
const servers = base.webServer === undefined ? undefined : [base.webServer].flat().map(server => ({ ...server, cwd: root }));
const size = (width: number, height: number, hasTouch = false) => ({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch });

export default defineConfig({
  ...base,
  globalTeardown: base.globalTeardown && path.resolve(__dirname, '../global-teardown.ts'),
  webServer: servers,
  testDir: '.',
  testIgnore: [],
  timeout: 30 * 60_000,
  projects: [
    { name: 'desktop', use: size(1280, 800) },
    { name: 'tablet', use: size(1024, 768) },
    { name: 'phone', use: size(390, 844, true) },
  ],
});
