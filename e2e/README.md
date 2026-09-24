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

`E2E product 4` has a second variant (`E2E-4B`, alongside `E2E-4`) so the
variant chooser — the app's only stock display, which opens only for a
product with more than one variant — has something to exercise. `live-stock.spec.ts`
signs in, opens the chooser and, using the admin API directly (restoring the
level in `finally`), proves the app's ADR-060 stock reconcile reaches the
chooser without a catalogue pull: one test flips `E2E-4B`'s stock and
triggers a reconcile pass via a visibility change (overriding
`document.visibilityState` and dispatching `visibilitychange`, since the
app's `AppState` on web follows page visibility); the other sells `E2E-1`
while route-intercepting `/tally/v1/commands` to add an `insufficient_stock`
warning to the result, which the app treats as its own trigger for a pass,
with no visibility change needed. Neither test sells `E2E-5` or leaves stock
changed.

`live-tab.spec.ts` proves ADR-061 (exactly one live tab per store): a second
tab takes over from the first, which shows a "MedusaPOS is open in another
tab" screen with no search box, and "Use here" hands the POS back; a payment
in the tender stage defers the hand-over up to 10 s before the second tab
goes live (no sale is completed); closing the live tab, rather than a
graceful hand-over, frees a waiting tab within 5 s; and a `pagehide`/
`pageshow` cycle (the browser's back-forward cache) parks the tab and then
reopens both the product cache and the order store fresh, checked with a
sale of `E2E-1`. It uses the shared sign-in fixture and sells only `E2E-1`.

CI runs all tests on every PR in **End-to-end (web)** with Postgres 17 and
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

## Intermittent SKU-lookup miss

**Symptom:** in `offline.spec.ts`, `sellBySku` types a SKU (E2E-3 or E2E-4),
presses Enter, and the search box keeps the SKU: the app's local catalogue
lookup found nothing at that moment.

**What is ruled out:** SKU lookup is local (over the replicated catalogue);
the catalogue replicates from `/admin/products`, which does not use the
search module. The `Search index "product" has no active version yet` lines
in the backend log come from search consumers before the first seed finishes
and are not linked to the lookup.

**Tally (2026-09-24),** e2e runs with the dev store's product search index
working (PR #28):
- before CI diagnostics (#33): 3 misses in 8 runs;
- with diagnostics, TallyUI 78cada7/851206a: 0 in 9;
- with TallyUI 6b1b0b7 (Medusa connector replication cursor fix, TallyUI
  #48): 0 in 10.

The cursor fix is a plausible cause of the change but not proven.

**Diagnostics:** CI keeps a Playwright trace for failed tests
(`retain-on-failure`), and e2e web builds (`EXPO_PUBLIC_E2E_DEBUG=1`) keep a
catalogue snapshot on `window.__medusaposCatalogue`; on a miss, `sellBySku`
attaches it to the test as `catalogue-snapshot` (in the `e2e-failure` CI
artifact). Production builds carry none of this.

**Rule:** a SKU-lookup miss is a bug, not a flake: do not rerun it away.
Download the `e2e-failure` artifact, read `catalogue-snapshot` and the trace,
and open an issue with them.
