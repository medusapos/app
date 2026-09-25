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

Locally, each checkout gets its own backend port, app port and database,
derived from the checkout's absolute path (`e2e/ports.ts`), so two checkouts
can run the harness at once without colliding. CI keeps the fixed values used
throughout the rest of this doc: `:9100`, `:8099` and `medusapos_e2e`. Started
without those env vars (as a manual probe does — see below), `start.sh` keeps
the same defaults.

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

The till prices through TallyUI's store settings (TV4) and Medusa's store
API (D2b), so the seed also has two regions and no default region: Europe
(dk, prices exclusive through the EUR currency preference) and Germany (de,
inclusive through its own region preference). It has one publishable key (the
one Medusa creates at boot) linked to the E2E channel, and an unlisted product, `E2E unlisted` (`E2E-U`), priced and
stocked but only in another sales channel. (Medusa 2.21.0 skips the store
API's channel filter only when the store has at most one sales channel; with
several, a product in no channel is excluded for every key. Its own channel
keeps it unlisted for the E2E key either way.) A fresh sign-in therefore shows "Set up this
till"; `signIn` picks Europe (its `region` argument), so the other specs keep
their Danish 25% exclusive totals. `pricing.spec.ts` proves the choice screen,
the "does not cover" error for Germany (the Copenhagen location is in dk, and
the country always follows the stock location), Medusa's calculated Europe
price for `E2E-1` in the catalogue, an exclusive sale applied with no
warnings, that `E2E-U` stays hidden ("5 products"), that a region change
resyncs the catalogue at the new region's price (the test gives `E2E-1` a
Germany price and moves the location to de, then restores both), and that the
choice survives a reload. It sells only `E2E-1`.

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
with no visibility change needed. A third delays `/admin/inventory-items` 750 ms under an open chooser, which must turn Out of Stock with no reopen (ADR 0007: the chooser is live).
None of them sells `E2E-5` or leaves stock
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

`storage.spec.ts` proves the SQLite-wasm storage switch (ADR-061 part A): one
test sells `E2E-1` with `/tally/v1/commands` route-blocked (the sale stays
pending), then reloads with `/admin/products` also blocked — the catalogue
still shows the 5 products and the pending sale from the SQLite-wasm cache,
not the network — before unrouting both and checking the sale syncs. The
other seeds one pending `E2E-1` order into the pre-SQLite Dexie order
database via `window.__medusaposSeedLegacyOrder` (an `EXPO_PUBLIC_E2E_DEBUG`
hook, like `__medusaposCatalogue`) before signing in, then checks the order
carries over, syncs, and the legacy Dexie database is gone afterwards. Both
sell only `E2E-1` and check its stock delta, like `smoke.spec.ts`.
Both seed at `pos_orders` schema v0 (pre-TallyUI #123): the legacy hook, and
`__medusaposSeedV0Order` into the SQLite order store, whose test signs in with
`/tally/v1/commands` blocked, sees the migrated sale "Waiting to sync", then
one Medusa order.
Both open `pos_orders` through TallyUI's `addPosOrderCollection` (ADR-032 amendment 2); a DM4 has no e2e (production web storage doesn't validate), so `order-store.test.ts` covers DM4 then fix.

Every `window.__medusapos…` hook goes through `apps/expo/lib/e2e-debug.ts`
(`exposeE2eHook('Catalogue', …)`), the only app code that writes to `window`
for E2E. Its branch is guarded by `EXPO_PUBLIC_E2E_DEBUG === '1'`, which a
production export folds away together with the branch's marker
`medusapos-e2e-debug-hook`. `scripts/check-web-bundle.sh` fails closed: on
that marker (or a `__medusapos…` name or a key) in any exported `.js`/`.html`,
on any file it cannot read, and on app source outside that module and tests
that contains `__medusapos` or writes a `window` property.

The same file proves the storage-health prompts (ADR-061 part B): one test
kills the storage worker via `window.__medusaposKillStorageWorker()` (another
`EXPO_PUBLIC_E2E_DEBUG` hook, terminating the worker without forgetting the
storage), then searches and completes a cash sale for `E2E-1` — expecting
"Saving is slow…", then "Storage stopped", then a Reload that brings the app
back live (the killed sale itself is never checked). The other opens a second
page at the static worker URL and starts a bare `Worker` there to hold the
opfs-sahpool pool outside the coordinator, then signs in and expects the
blocked screen with Reload; closing the holder page and reloading recovers.

`discount.spec.ts` proves cart discounts (TallyUI ADR-062). One test signs in
(the plugin reports `order.create` 1 and 2, so the session stores 2), gives
two `E2E-1` a 10% line discount and a €0.50 order discount, checks that the
cart and the receipt show TallyUI's `order.display` rows (ADR 0008): the line
at €4.00 before its discounts, its "10% −€0.40" chip (receipt: "10% off"
−€0.40), the order discount −€0.50, then Subtotal €4.00, Discount €0.90,
VAT €0.78 and Total €3.88. It pays exact cash,
and expects the outbox result `applied` with no warnings, a version 2 command,
Medusa's total equal to the till's, and one "POS discount" adjustment of the
line's `discountMinor`. The other route-intercepts `GET /tally/v1/info` to a
404 before a fresh sign-in (capability 1): applying a discount shows TallyUI's
`finalize: discounts are not supported by the server yet (order.create v2)`
at once, nothing is sent, and the undiscounted sale then goes out as version 1.
A third gives `E2E-1` 100% off and completes it with cash at €0.00: applied
with no warnings, a server `totalMinor` of 0 and one Medusa order (the plugin
needs no payment collection for it). All three sell only `E2E-1`.

`phone-cart.spec.ts` is the one spec at a phone viewport (360 × 740; the
others run at Desktop Chrome, 1280 × 720) and proves the phone sale layout
(ADR 0009). It adds two `E2E-1` by scan and checks that the cart bar is the
full width, at least 56 px tall and reads "2 items". It opens the cart, gives
the line 10% off and the order €0.50 off, and goes back to see the bar's
€3.88. It reopens the cart and expects the line, the Total row and the
side-by-side Cash and Card terminal buttons in the viewport, and again after
scrolling to the order discount chip. A tap on `E2E-2` stays on Products with
"3 items". With the order discount form open the two lines overflow, so
scrolling to its Cancel moves the first line out of view while Total and Cash
stay. It pays exact cash, and the new sale opens on Products with "Cart is
empty". A second test opens the cart, keyboard-wedge scans `E2E-2` in (typed
with `delay: 10`, staying on Cart), scans an unknown code to see the "No
product matches" alert with nothing added, types into the line's discount
form without triggering a scan, then pays exact cash for `E2E-1` and `E2E-2`.

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
