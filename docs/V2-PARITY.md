# WCPOS v2 parity: what the Medusa app has

This file lists the features of WCPOS v2 and says how far the MedusaPOS app has each one, so that choosing the next item never needs a ruling. The lane takes the first open row of **Default order** (at the end) unless the front desk says otherwise. Update this file in the PR that changes a row.

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
| Order note | 2.0 (FS, RS) | Missing | TallyUI 3.8.0 ships `CartNoteInput` and an order `note` field; the app does not use them. Whether the note reaches Medusa through `order.create` was not checked | app, then plugin |
| Wide and phone layouts | Free (RS) | Has | Phone below 600 wide (`docs/adr/0009`); `e2e/phone-cart.spec.ts` "at 360 × 740 the lines scroll under pinned totals and pay, and the cart bar counts items" | — |
| Prevent overselling | Free (FS) | Partial | The till never refuses a sale; the plugin applies it and returns `insufficient_stock` (`docs/adr/0003`, `workflows/tally-order-create/stock.ts`). Nothing warns the cashier before checkout | TallyUI, then app |

## Products and search

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Search | Free (FS, RS) | Has | TallyUI `Catalogue`; `e2e/settings.spec.ts` "a saved minChars gates Enter in the Products search: a shorter code stays a search" | — |
| Grid/table toggle, category navigation | Free (FS, RS) | Missing | TallyUI 3.8.0 `Catalogue` has `showViewToggle` and `showCategoryNav` (both off by default); the app passes neither | app |
| Variations: one tile, then pick the variant | Free (RS) | Has | Live variant chooser (`docs/adr/0007`); `e2e/live-stock.spec.ts` "stock change reaches the chooser without a catalogue pull" | — |
| Browse by tag, brand or shortcut; filter chips | 2.0 (RS) | Missing | No TallyUI component found in 3.8.0 | TallyUI |
| Region prices | Pro (PRO, store pricing) | Has | `e2e/pricing.spec.ts` "the catalogue shows E2E-1 at Medusa's calculated price for Europe" and "a region change resyncs the catalogue at the new region's price" | — |
| Stock, price and cost editing | Pro (PRO) | Missing | Not found in `apps/expo` or the plugin | TallyUI + plugin |

## Customers

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Search and attach a customer; guest sales | Free (FS) | Has | TallyUI `CustomerPicker`; `e2e/customers.spec.ts` "a searched customer is linked to the Medusa order" | — |
| Create a customer at the till | Pro (MS) | Has | `e2e/customers.spec.ts` "a customer created at the till is linked to the Medusa order" | — |
| Customers management screen | Pro (MS) | Missing | No route in `apps/expo/app` | TallyUI, then app |

## Checkout and payments

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Cash with change | Free (FS, PC) | Has | TallyUI `Tender`; `e2e/smoke.spec.ts` "cash sale is completed, captured and deducted from stock" | — |
| Card recorded as an external payment | Free (PC) | Has | `e2e/split-tender.spec.ts` (card leg) | — |
| Split payment | 2.0 (CMP) | Has | TallyUI `SplitTender`; `e2e/split-tender.spec.ts` "a split card-and-cash sale reaches Medusa once at the till's total, with both payments, and the receipt lists both" | — |
| Offline checkout | 2.0 (CMP) | Has | `e2e/offline.spec.ts` "25 sales, 20 offline, land exactly once" | — |
| Gateways and terminals (Stripe Terminal, SumUp, Mollie), Tap to Pay | Pro (PRO, PC) | Missing | Not found in TallyUI 3.8.0 or the plugin | TallyUI + plugin |
| Tips; order status per gateway | Free (FS, PC) | Missing | Not found in TallyUI 3.8.0 or the plugin | TallyUI + plugin |
| Customer-facing display | Pro (CMP) | Missing | Not found in TallyUI 3.8.0 | TallyUI |

## Receipts and printing

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| On-screen receipt; browser print | Free (FR) | Has | TallyUI `Receipt` and the "Print receipt" button in `apps/expo/app/index.tsx`; receipt checked in `e2e/split-tender.spec.ts` | — |
| Email receipt (with an offline queue) | Free (FR) | Missing | Not found in TallyUI 3.8.0 or the plugin | TallyUI + plugin |
| Receipt templates, gallery, fiscal mode | Free (FR) | Missing | One fixed layout | TallyUI |
| Thermal ESC/POS, cloud printing, routing between printers | Free (FR) | Missing | Printer settings "land here later (ADR 0016)" (`apps/expo/app/settings.tsx`) | TallyUI |

## Orders and refunds

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Order history from the store | Pro (MS) | Partial | `apps/expo/app/orders.tsx` shows `OrdersList` of this till's outbox only. Waiting: TallyUI G7 b3, the `/tally/v1/orders` route spec (issue number to confirm) | TallyUI, then plugin + app |
| Refunds | Pro (CR, PRO) | Missing | No refund command in plugin 0.2.2; TallyUI 3.8.0 has "no refund model yet" (`use-register-session.ts`). Waiting: TallyUI G7 b3 (issue number to confirm) | TallyUI, then plugin + app |
| Coupons in the cart | 2.0 (CMP, PRO) | Missing | Waiting: TallyUI#500 / #501 (ADR-077; d1, d3a merged; d2 in TallyUI PR #513; d3/d4 in flight). The plugin then needs a mapping: `createOrderWorkflow`'s promotion refresh drops adjustments without an applied promotion code (`workflows/tally-order-create/plan.ts`) | TallyUI, then plugin |

## Registers, cash and reports

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Open with float, cash in/out, count, close | 2.0 (RG, CMP) | Has | Register commands v1–2; `e2e/register.spec.ts` "bind, open with a float, a cash sale, a paid in and its Undo, and Close register" (1280×800 and 360×780) | — |
| A close whose closure write failed | 2.0 (RG) | Has | `e2e/register.spec.ts` "a close whose closure write failed shows TallyUI's Finish closing card, which completes it with the stored count" | — |
| Take-over by another till | 2.0 (RG) | Has | PR #243 (TallyUI 3.8.0) and PR #245; `e2e/register.spec.ts` "Register 1 open on another till: the conflict card names it, Take over, then a cash sale reaches Medusa" | — |
| Superseded refusal on the losing till; resume after lost local state | 2.0 (RG) | Partial | Plugin-proven only (`integration-tests/http/registers.spec.ts`, "register v2 open"); no e2e drives the losing till or a resume | app (an e2e) |
| Approval of an over-variance close | 2.0 (RG) | Partial | The app checks a second admin login (`apps/expo/lib/approval.ts`); `e2e/register.spec.ts` "over the threshold: the approval dialog, its offline refusal, then a manager login approves the close". The plugin stores `approvedBy` as given and does not check it | plugin |
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
| Sign in again after a 401; session list | Free (FS) | Partial | `e2e/strips.spec.ts` "sign-in strip: outbox pauses after three 401s, resumes once signed in again" and "a product pull refused with 401 signs the till out"; no session list or revoke. Shared strip waits on TallyUI#373 (`docs/PLAN.md`, #174 item 4) | TallyUI |
| Roles and capabilities | Free (PERM) | Partial | Any Medusa admin can sign in; no POS role or capability found in the plugin | plugin |
| Switching cashiers | — (WCPOS lacks it too, PERM) | Missing | — | TallyUI |
| Settings screen | Free (FS) | Partial | Scanner only (`apps/expo/app/settings.tsx`); register and printer settings "land here later (ADR 0016)" | app |

## Barcode, tax, stores, language

| Feature | WCPOS tier (source) | Status | Evidence / what is left | Owner of the rest |
|---|---|---|---|---|
| Keyboard-wedge scan, minimum length | Free (BS) | Has | `apps/expo/lib/use-wedge-scan.ts`; `e2e/phone-cart.spec.ts` "a keyboard-wedge scan in the cart view adds a product, and an unknown code alerts without adding one"; `e2e/settings.spec.ts` "a saved minChars gates the wedge scan, and the test-scan field reports its verdict" | — |
| Camera scan; scan sounds | Free (BS) | Missing | Not found in TallyUI 3.8.0 | TallyUI |
| Tax per rate | Free (FS) | Has | `Cart` `taxLabel` "VAT n%"; region tax-inclusive prices | — |
| Multi-store | Pro (PRO) | Partial | One region per till (`StoreSettingsChoiceScreen`); `e2e/pricing.spec.ts` "a fresh till chooses its region; Germany does not cover the Copenhagen location (D1)". No store switching | TallyUI + plugin |
| Translations, RTL, store locale | Free / Pro (INT) | Missing | English only | TallyUI |
| Extension directory, add-ons, Pro upsell | Free / Pro (FS, PRO) | N/A | — | — |

## App-local gaps

1. Register v2 e2e against plugin 0.2.2: the losing till's `register_session_superseded` refusal for a session opened at contract 2, and resume after lost local state (take-over itself is covered by `e2e/register.spec.ts`).
2. Pass `showViewToggle` and `showCategoryNav` to `Catalogue` (app).
3. Order note: wire `CartNoteInput`, then check the note reaches the Medusa order (app, then plugin).
4. Approval: the plugin checks `approvedBy` names a real admin (plugin).
5. Settings screen: register and printer settings (ADR 0016) (app).
6. A POS role or capability for sign-in (plugin).

## Default order

The next item is the first row here that is not done. Rows marked TallyUI start as a note to the front desk, which dispatches the TV job; this repo then takes the bump.

1. Register v2 store side and the till side: #174 item 1, PR #243 (TallyUI 3.8.0). Done.
2. The superseded refusal follows the losing session's own open: PR #245. Done.
3. The app-local gaps above, in their order.
4. Coupons: waiting on TallyUI#500 / #501 (d2 in TallyUI PR #513), then the plugin's promotion mapping.
5. Order history from the store: waiting on TallyUI G7 b3, `/tally/v1/orders` (issue number to confirm).
6. Refunds: waiting on TallyUI G7 b3 (issue number to confirm); they start from an order.
7. Everything else, in table order.
