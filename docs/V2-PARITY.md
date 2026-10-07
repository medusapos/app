# Core POS features: what the Medusa app has

This file lists the core POS features a Medusa merchant expects and says how far the MedusaPOS app has each one, so that choosing the next item never needs a ruling.

**Each row is a user expectation, built Medusa's own way.** WCPOS v2 is the reference for which features a POS needs, and for taste. It is not the spec for how they work: a row is built with Medusa's own pieces (RBAC roles and policies, regions and price lists, sales channels and stock locations, payment providers, promotions, returns, the notification module), never by copying how WCPOS does it on WooCommerce (Paul, 2026-10-07). Where a WooCommerce mechanism has no Medusa meaning, the row says so. The lane takes the first open row of **Default order** (at the end) unless the front desk says otherwise. Update this file in the PR that changes a row.

Read on 2026-10-07:
- **The app:** medusapos `main` at `88af56c`, `@tallyui/*` 3.8.0 (pinned in `apps/expo/package.json`), plugin 0.2.2 (`packages/medusa-plugin`). `apps/desktop` is a stub (its build script is a TODO); the MVP is web only (`docs/A-TRACK.md`).
- **WCPOS:** the WCPOS wiki (`~/Projects/wiki`), i.e. the shipped 1.10 line plus the merged but unreleased 2.0 features.

Quoted test names are Playwright tests in `e2e/` (repo root); each row names its file.

**Key**
- **WCPOS tier:** Free, Pro, or 2.0 (merged, not yet released).
- **Status:** Has, Partial, Missing, or N/A (no Medusa meaning).
- **Owner:** where the missing part belongs.
  - **TallyUI:** platform-neutral; a TV job there, then a version bump here.
  - **app:** `apps/expo` (and `apps/desktop` if a row needs it).
  - **plugin:** `packages/medusa-plugin`.
  - **dev store:** `dev/medusa-store`.

**Wiki sources** (paths under `~/Projects/wiki/`)
- `FS` `product/features/free-selling.md`
- `FR` `product/features/free-receipts-and-printing.md`
- `PRO` `product/features/pro-and-add-ons.md`
- `CMP` `product/features/comparison-and-pricing.md`
- `RS` `architecture/client/register-screen.md`
- `MS` `architecture/client/management-screens.md`
- `RG` `architecture/client/register-sessions.md`
- `PC` `architecture/client/payments-contract.md`
- `RC` `architecture/client/reports-and-closures.md`
- `CR` `architecture/client/checkout-refunds.md`
- `BS` `support/products/barcode-scanning.md`
- `INT` `support/international.md`
- `PERM` `support/permissions.md`

## Selling and cart

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Cart: quantity, remove a line, edit a line's price | Free (FS, RS) | Has | TallyUI `Cart` with `canEditPrice` in `apps/expo/app/index.tsx`; `e2e/parked-sales.spec.ts` "an edited unit price settles in Medusa at the till's total with no warnings" | — |
| Line and order discounts | Free (FS) | Has | `order.create` v4; `e2e/discount.spec.ts` "a discounted sale is applied as order.create v4, with a \"POS discount\" adjustment of the line's discount" and "100% off the line completes with cash at €0.00 as one Medusa order" | — |
| Fees, shipping, custom lines | Free (FS) | Has | `order.create` v5 (`docs/adr/0021`); `e2e/charges.spec.ts` "a sale with a fee, shipping and a custom item reaches Medusa once at the till's total, with the shipping as a shipping method" | — |
| Park and resume a sale | Free (RS) | Has | TallyUI `ParkedSales`; `e2e/parked-sales.spec.ts` "park a sale, sell another, resume the first and complete it: both orders reach Medusa once at the till's figures" | — |
| Several open orders as tabs | 2.0 (FS, RS) | Missing | Parking only | TallyUI |
| Order note | 2.0 (FS, RS) | Missing | TallyUI 3.8.0 ships `CartNoteInput` and an order `note` field; the app does not use them: `useSale` has no `setNote` yet (TallyUI#520). The plugin drops the note too: `tally-order-create/plan.ts` maps only `registerId` and `cashierRef` into the order metadata | TallyUI, then app and plugin |
| Wide and phone layouts | Free (RS) | Has | Phone below 600 wide (`docs/adr/0009`); `e2e/phone-cart.spec.ts` "at 360 × 740 the lines scroll under pinned totals and pay, and the cart bar counts items" | — |
| Know before selling what is out of stock | Free (FS) | Partial | The till never refuses a sale; the plugin applies it and returns `insufficient_stock` (`docs/adr/0003`, `workflows/tally-order-create/stock.ts`). Nothing warns the cashier before checkout. Medusa's way: the variant's own `manage_inventory` and `allow_backorder` decide, against the stock location's levels | TallyUI, then app |

## Products and search

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Search | Free (FS, RS) | Has | TallyUI `Catalogue`; `e2e/settings.spec.ts` "a saved minChars gates Enter in the Products search: a shorter code stays a search" | — |
| Grid/table toggle, category navigation | Free (FS, RS) | Has | TallyUI `Catalogue` with `showCategoryNav`, and `showViewToggle` above phone width; the view is kept per store on the device (`apps/expo/lib/catalogue-view.ts`); `e2e/catalogue-view.spec.ts` "a category narrows the catalogue, All products restores it, and the table view survives a reload" and "a phone shows the category nav and no grid/table toggle" | — |
| Variations: one tile, then pick the variant | Free (RS) | Has | Live variant chooser (`docs/adr/0007`); `e2e/live-stock.spec.ts` "stock change reaches the chooser without a catalogue pull" | — |
| Browse by tag, brand or shortcut; filter chips | 2.0 (RS) | Missing | No TallyUI component found in 3.8.0 | TallyUI |
| Region prices | Pro (PRO, store pricing) | Has | `e2e/pricing.spec.ts` "the catalogue shows E2E-1 at Medusa's calculated price for Europe" and "a region change resyncs the catalogue at the new region's price" | — |
| Fix a stock count or a price at the counter | Pro (PRO) | Missing | Not found in `apps/expo` or the plugin. Medusa Admin already edits both; at the till this means a quick change through Medusa's inventory levels and prices, as the signed-in user's role allows | TallyUI + plugin |

## Customers

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Search and attach a customer; guest sales | Free (FS) | Has | TallyUI `CustomerPicker`; `e2e/customers.spec.ts` "a searched customer is linked to the Medusa order" | — |
| Create a customer at the till | Pro (MS) | Has | `e2e/customers.spec.ts` "a customer created at the till is linked to the Medusa order" | — |
| Look up and edit a customer at the till | Pro (MS) | Missing | No route in `apps/expo/app`. Medusa Admin keeps the full customer screens; the till needs the counter's view of Medusa customers | TallyUI, then app |

## Checkout and payments

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Cash with change | Free (FS, PC) | Has | TallyUI `Tender`; `e2e/smoke.spec.ts` "cash sale is completed, captured and deducted from stock" | — |
| Card recorded as an external payment | Free (PC) | Has | `e2e/split-tender.spec.ts` (card leg) | — |
| Split payment | 2.0 (CMP) | Has | TallyUI `SplitTender`; `e2e/split-tender.spec.ts` "a split card-and-cash sale reaches Medusa once at the till's total, with both payments, and the receipt lists both" | — |
| Offline checkout | 2.0 (CMP) | Has | `e2e/offline.spec.ts` "25 sales, 20 offline, land exactly once" | — |
| Take a card on a terminal, Tap to Pay | Pro (PRO, PC) | Missing | Not found in TallyUI 3.8.0 or the plugin. Medusa's way: the store's own Medusa payment providers (Stripe and others), not a POS-side gateway list | TallyUI + plugin |
| Tips | Free (FS, PC) | Missing | Not found in TallyUI 3.8.0 or the plugin | TallyUI + plugin |
| Order status per gateway | Free (FS, PC) | N/A | A WooCommerce setting. A Medusa order carries its own payment and fulfilment status, which the plugin sets when it captures the till's payments | — |
| Customer-facing display | Pro (CMP) | Missing | Not found in TallyUI 3.8.0 | TallyUI |

## Receipts and printing

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| On-screen receipt; browser print | Free (FR) | Has | TallyUI `Receipt` and the "Print receipt" button in `apps/expo/app/index.tsx`; receipt checked in `e2e/split-tender.spec.ts` | — |
| Email receipt (with an offline queue) | Free (FR) | Missing | Not found in TallyUI 3.8.0 or the plugin. Medusa's way: the store's notification module sends it | TallyUI + plugin |
| Receipt templates, gallery, fiscal mode | Free (FR) | Missing | One fixed layout | TallyUI |
| Thermal ESC/POS, cloud printing, routing between printers | Free (FR) | Missing | Printer settings "land here later (ADR 0016)" (`apps/expo/app/settings.tsx`) | TallyUI |

## Orders and refunds

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Order history from the store | Pro (MS) | Partial | `apps/expo/app/orders.tsx` shows `OrdersList` of this till's outbox only. Waiting: TallyUI G7 b3, the `/tally/v1/orders` route spec (issue number to confirm) | TallyUI, then plugin + app |
| Refunds | Pro (CR, PRO) | Missing | No refund command in plugin 0.2.2; TallyUI 3.8.0 has "no refund model yet" (`use-register-session.ts`). Waiting: TallyUI G7 b3 (issue number to confirm). Medusa's way: its own returns and refund workflows on the order | TallyUI, then plugin + app |
| Coupons in the cart | 2.0 (CMP, PRO) | Missing | Waiting: TallyUI#500 / #501 (ADR-077; d1, d3a merged; d2 in TallyUI PR #513; d3/d4 in flight). The plugin then needs a mapping: `createOrderWorkflow`'s promotion refresh drops adjustments without an applied promotion code (`workflows/tally-order-create/plan.ts`) | TallyUI, then plugin |

## Registers, cash and reports

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Open with float, cash in/out, count, close | 2.0 (RG, CMP) | Has | Register commands v1–2; `e2e/register.spec.ts` "bind, open with a float, a cash sale, a paid in and its Undo, and Close register" (1280×800 and 360×780) | — |
| A close whose closure write failed | 2.0 (RG) | Has | `e2e/register.spec.ts` "a close whose closure write failed shows TallyUI's Finish closing card, which completes it with the stored count" | — |
| Take-over by another till | 2.0 (RG) | Has | PR #243 (TallyUI 3.8.0) and PR #245; `e2e/register.spec.ts` "Register 1 open on another till: the conflict card names it, Take over, then a cash sale reaches Medusa" | — |
| Superseded refusal on the losing till; resume after lost local state | 2.0 (RG) | Has | `e2e/register.spec.ts` "Register 1 taken over by another till: this till's paid in is refused superseded, and it shows the register closed" and "a till that lost its local state opens Register 1 again and resumes its store session, then a cash sale reaches Medusa". TallyUI 3.8.0 has no superseded view of its own: the till shows the open card and the pill reads "Register closed" | — |
| Approval of an over-variance close | 2.0 (RG) | Partial | The app checks a second admin login (`apps/expo/lib/approval.ts`); `e2e/register.spec.ts` "over the threshold: the approval dialog, its offline refusal, then a manager login approves the close". The plugin stores `approvedBy` as recorded data: recorded, not verified; proof design in ADR 0023 (accepted) | plugin |
| Reports: today's sales on this register, closure history, X-report, reprint | 2.0 / Pro, still moving (RC, CMP) | Missing | TallyUI 3.8.0 `pos` has `export-csv.ts` and `closure-document.ts`; no reports screen in `apps/expo`. `GET /tally/v1/registers/:id` serves the open session, not a closure history | TallyUI + plugin |

## Offline and sync

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Offline catalogue, queued orders, exactly-once | Free (FS) | Has | SQLite-wasm (`apps/expo/lib/web-storage.ts`); `e2e/outbox.spec.ts` "two cash sales in quick succession both reach Medusa once, with no reload"; `e2e/storage.spec.ts` "cold open, offline sale, and reload keep the SQLite catalogue and carry the sale forward" | — |
| Sync status; a refused batch | Free (FS) | Has | TallyUI `SyncStatus`; `e2e/strips.spec.ts` "refused strip: shows the store's refusal reason and recovers via Try again" | — |
| One tab per till | 2.0 (single instance) | Has | `e2e/live-tab.spec.ts` "a second tab takes over, and \"Use here\" reclaims it" | — |
| Log viewer | Free (FS) | Missing | Logging and "Send feedback" only (`apps/expo/lib/logging.ts`, `apps/expo/app/orders.tsx`) | TallyUI |

## Users, sign-in and settings

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Connect and sign in | Free (FS) | Has | `apps/expo/app/login.tsx` (Medusa admin login); `e2e/demo.spec.ts` "one click on /demo reaches the POS with products" | — |
| Sign in again without losing sales | Free (FS) | Has | `e2e/strips.spec.ts` "sign-in strip: outbox pauses after three 401s, resumes once signed in again" and "a product pull refused with 401 signs the till out". Shared strip waits on TallyUI#373 (`docs/PLAN.md`, #174 item 4) | TallyUI |
| Session list and revoke | Free (FS) | N/A | WCPOS lists WordPress sessions. Medusa tokens are stateless JWTs with no session to list or revoke; access ends by removing the user's POS role (at their next sign-in or refresh) or by rotating `jwtSecret` (ADR 0023) | — |
| Roles and capabilities | Free (PERM) | Partial | Any Medusa admin can sign in; no POS role or capability found in the plugin. Design in ADR 0023 (accepted): Medusa RBAC policies `tally_pos:use` and `tally_pos:approve_variance` | plugin |
| Switching cashiers | — (WCPOS lacks it too, PERM) | Missing | — | TallyUI |
| Settings screen | Free (FS) | Partial | Register (till name) and Scanner (`apps/expo/app/settings.tsx`); printer settings wait on TallyUI printing (Receipts and printing row) | app |

## Barcode, tax, stores, language

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Keyboard-wedge scan, minimum length | Free (BS) | Has | `apps/expo/lib/use-wedge-scan.ts`; `e2e/phone-cart.spec.ts` "a keyboard-wedge scan in the cart view adds a product, and an unknown code alerts without adding one"; `e2e/settings.spec.ts` "a saved minChars gates the wedge scan, and the test-scan field reports its verdict" | — |
| Camera scan; scan sounds | Free (BS) | Missing | Not found in TallyUI 3.8.0 | TallyUI |
| Tax per rate | Free (FS) | Has | `Cart` `taxLabel` "VAT n%"; region tax-inclusive prices | — |
| Sell for more than one shop or location | Pro (PRO) | Partial | Each till sells on the store's default sales channel and chooses its region and one of that channel's stock locations (`StoreSettingsChoiceScreen`, `apps/expo/lib/store-settings.ts`); `e2e/pricing.spec.ts` "a fresh till chooses its region; Germany does not cover the Copenhagen location (D1)". Medusa's way is one store with several sales channels, regions and stock locations, not several stores. Left: choosing a sales channel other than the default, and switching without re-choosing | TallyUI + plugin |
| Translations, RTL, store locale | Free / Pro (INT) | Missing | English only | TallyUI |
| Extension directory, add-ons, Pro upsell | Free / Pro (FS, PRO) | N/A | — | — |

## App-local gaps

1. Register v2 e2e against plugin 0.2.2: the losing till's `register_session_superseded` refusal for a session opened at contract 2, and resume after lost local state (take-over itself is covered by `e2e/register.spec.ts`). Done (#247).
2. Pass `showViewToggle` and `showCategoryNav` to `Catalogue` (app). Done (#248).
3. Order note: waits on TallyUI#520 (`useSale` `setNote`). Then wire `CartNoteInput` (app) and map `order.note` in `tally-order-create` (plugin).
4. Approval: recorded, not verified; proof design in ADR 0023 (accepted), the second of its two PRs, after a TallyUI ask for register contract 3. A user-exists check is ruled out (front desk, 2026-10-07): it would claim a verification it does not do. The follow-up's shape: the manager authenticates against the store with their own credential (PIN or login, verified server side), the store issues a short-lived single-use approval proof bound to the register session id and the variance amount, the close command carries it, and the plugin verifies it.
5. Settings screen: register and printer settings (ADR 0016) (app). Till name done (#250); printer settings are TallyUI's.
6. A POS role or capability for sign-in (plugin). Design in ADR 0023 (accepted), the first of its two PRs.

## Default order

The next item is the first row here that is not done. Rows marked TallyUI start as a note to the front desk, which dispatches the TV job; this repo then takes the bump.

1. Register v2 store side and the till side: #174 item 1, PR #243 (TallyUI 3.8.0). Done.
2. The superseded refusal follows the losing session's own open: PR #245. Done.
3. The app-local gaps above, in their order.
4. Coupons: waiting on TallyUI#500 / #501 (d2 in TallyUI PR #513), then the plugin's promotion mapping.
5. Order history from the store: waiting on TallyUI G7 b3, `/tally/v1/orders` (issue number to confirm).
6. Refunds: waiting on TallyUI G7 b3 (issue number to confirm); they start from an order.
7. Everything else, in table order.
