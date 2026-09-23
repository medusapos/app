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

Every fresh harness start destroys only `medusapos_e2e`. It never touches the
shared dev store. Playwright stops the servers it starts. Outside CI, already
running e2e servers are reused: stop those yourself before a fresh run, since
the smoke test expects a freshly seeded database. Traces are saved on first retry;
results and temporary build/pack artifacts are ignored by Git.
