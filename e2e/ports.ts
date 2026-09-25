import { createHash } from 'node:crypto';
import path from 'node:path';

// This file's own directory (e2e/), one level up — fixed by this file's location, not by the
// caller's cwd, so the Playwright main process, its workers and the web-server commands agree.
const repoRoot = path.resolve(__dirname, '..');
const id = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
const offset = parseInt(id, 16) % 400;

/**
 * Each checkout's own e2e ports and database, derived from its absolute path, so two checkouts
 * running the harness at once never collide on :9100, :8099 or `medusapos_e2e` (2026-09-25).
 * `E2E_BACKEND_URL`/`E2E_APP_URL` (hosted mode) still override everything, as before this file
 * existed. CI keeps today's fixed values so CI and its docs are unchanged.
 */
export const E2E_RUN = process.env.CI
  ? { id, backendPort: 9100, appPort: 8099, database: 'medusapos_e2e' }
  : { id, backendPort: 9100 + offset, appPort: 8100 + offset, database: `medusapos_e2e_${id}` };
