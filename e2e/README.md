# Throwaway end-to-end store

From the repo root, with dependencies and Playwright Chromium already installed:

```sh
pnpm e2e
# or
./node_modules/.bin/playwright test -c e2e/playwright.config.ts --workers=1
```

Postgres must be running on port 5432. The default connection is role `claude`,
no password, host `localhost`; CI can set `DB_USERNAME`, `DB_PASSWORD`, `DB_HOST`.
The role needs permission to create and drop **medusapos_e2e**.

Playwright builds and packs the plugin, installs that local tarball into
`dev/medusa-store` without changing lockfiles, drops/recreates `medusapos_e2e`,
migrates and seeds five taxed EUR products, and creates `e2e@tally.test` /
`e2e-password`. Only the local tarball is installed; npm runs offline.
Migration scripts are skipped to exclude the starter catalogue; `seed-e2e.ts`
provides the e2e data. The backend uses `medusa develop --port 9100` so no
backend production build is needed. npm and Medusa configuration stay in `e2e/.tmp/`.

The web export is built with backend URL `http://localhost:9100` and served on
`http://localhost:8099`, with SPA fallback. The smoke test signs in, sells
E2E-1 and E2E-4 for exact cash, reads the EUR 15 receipt (including 25% VAT),
then checks the completed, captured Medusa order and inventory decrement.
The offline test makes 25 sales (5 online, 20 offline), including cash with
change and a terminal sale of 3 × E2E-5 against stock of 2. It checks growing
pending counts, reconnects without reloading, then verifies exactly one paid,
completed Medusa order per captured client ID, POS totals, exact payment
amounts, inventory deltas (E2E-5 ends at −1), and the stock warning under
Orders → Needs attention. Both tests use their own client IDs and starting
stock, so either file can run first; Playwright uses one worker.

CI runs both tests on every PR in **End-to-end (web)** with Postgres 17 and
Chromium. Failures upload `test-results` and the HTML `playwright-report`.
Global teardown force-drops only `medusapos_e2e` after the run; a failed drop logs a warning without failing the run.

Every fresh harness start destroys only `medusapos_e2e`. It never touches the
shared dev store. Playwright stops the servers it starts. Outside CI, already
running e2e servers are reused: stop those yourself before repeating the full
suite, since the short-sale scenario requires E2E-5 to start at 2. Traces are saved on first retry;
results and temporary build/pack artifacts are ignored by Git.

## Against a hosted app and backend

Set `E2E_APP_URL` and `E2E_BACKEND_URL` (both, or the config refuses to load),
plus `E2E_EMAIL` and `E2E_PASSWORD`, to run against already-hosted servers:
Playwright then starts no servers and drops no database. The backend needs the
`E2E-*` fixture products from `seed-e2e.ts`; the hosted demo store has them
(see `deploy/demo-backend/README.md`). Run only `smoke.spec.ts` there:
the offline spec needs a fresh store where E2E-5 starts at 2.
