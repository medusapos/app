# Till coupons are Medusa promotion codes, priced by the store

Status: Accepted (front desk ruling 2026-11-11, decisions 1–3 with the conditions marked "desk condition")
Date: 2026-11-11
Supersedes: ADR 0024 decision 3 (the blanket `coupon_invalid` refusal)

## Context

v2 parity row 7 (`docs/v2-parity/DEMO-PARITY.md`) is the coupon a cashier types into the sale. On Medusa, a coupon is a promotion with a code. Medusa holds its rules, campaign budgets and usage limits, and nothing else should.

**The till side** ships in the next TallyUI batch release, expected 3.19.0 (TallyUI #709, #710):
- `OrderBuilder.setCoupons` takes coupon figures priced by the store. Each code gives `couponId` and, for each line, `{lineId, amountMinor}` in that line's own mode (tax-inclusive or not), applied after the line and order discounts.
- The till derives `discountMinor` and `discountTaxMinor` from those amounts.
- When the lines change, the order is marked stale, and finalize refuses a stale order.
- `createStorePricedDiscountCodes({supports, price})` in `@tallyui/pos` wraps a `price(codes, sale)` that the platform supplies.
  - `useSale` re-prices stale coupons, the way `resume()` does, and refuses tender while a price is stale.
- `parseInfoCapabilities` reads `coupons: true` from `/tally/v1/info`.
- TallyUI fixes no endpoint shape; that is this plugin's to define.

**The store side today:**
- `process.ts` refuses any coupon with `coupon_invalid` (ADR 0024 decision 3).
- `tallyOrderCreateWorkflow` writes a draft order with no `promo_codes`. The till's line discounts are code-less adjustments, because `createOrderWorkflow`'s promotion refresh deletes every adjustment whose code isn't an applied promotion.
- Since #290, the step `tally-drop-promotion-adjustments` removes whatever adjustments that refresh adds for automatic promotions.
- Medusa records promotion usage only in `completeCartWorkflow`, through `registerUsageStep`; nothing on the draft-order path records it.

The research behind this ADR, with file and line references into Medusa 2.21.0 and TallyUI 3.18.0, is in `~/agent/handoff/medusapos-coupons-findings-2026-11-11.md`.

## Decisions

### 1. The till prices coupons online, through one plugin function shared with order create
`POST /tally/v1/promotions/preview` uses the same authentication as the other `/tally/v1` routes.

**The request:**
- the register's region and currency, and the sale's customer id if it has one;
- `codes[]`;
- `lines[]`: `lineId`, `variantId`, `quantity`, `taxInclusive`, and `netMinor`. `netMinor` is the line's total in its own mode, after the till's line and order discounts.

**What the plugin does:** one function, `priceCoupons(context, codes)`, calls `promotionModuleService.computeActions(codes, context, { prevent_auto_promotions: true })`. The context's item `subtotal` (or `original_total` when tax-inclusive) is the till's `netMinor`, and `is_tax_inclusive` is the line's mode.

**The reply:**
- for each code that applies: `{ code, couponId: promotion.id, lines: [{ lineId, amountMinor }] }`;
- for each code that doesn't: `{ code, storeCode, message }`, with `storeCode` taken from decision 4.

**Offline:** the app's `price()` rejects with "Coupons need a connection". The till goes on trading without the coupon.

**Why:**
- A second rule engine in the till would drift from Medusa's.
- The receipt is the fiscal record (ADR 0012), so the till must know the amount before tender.
- Pricing on the net line makes the coupon apply after the till's discounts, as TallyUI #709 requires. Preview and create call the same function with the same context, so they can't disagree on how discounts stack.
- A hybrid that accepts codes offline and lets the store price them later is left open as a later step. It can't show the amount before tender.

### 2. On order create the store re-prices, compares, and writes the coupon adjustments itself
- **Pre-flight.** After the shape checks and before the claim, where the refusal sits today, the plugin rebuilds the context from the payload and runs `priceCoupons`. Each `coupons[i]` must:
  - match its code;
  - have `couponId` equal to the promotion's id;
  - have the sum of its line amounts within half a minor unit of `discountMinor + discountTaxMinor` in the lines' mode. That is ADR 0012's tolerance.

  Any failure means `coupon_invalid`, before an order exists.
- **The order carries what the cashier tendered on** (desk condition, 2026-11-11). The order is refused with `coupon_invalid` and its store code before the ledger claim, and is never stored at a total other than the one charged, when re-pricing gives a different amount because:
  - the promotion was edited since the preview: `amount_mismatch`;
  - it expired or was deactivated: `not_active`;
  - its rules no longer match: `not_applicable`;
  - its limit or budget was reached: `limit_reached` or `budget_exceeded`.
- **The write.** Inside `tallyOrderCreateWorkflow`, the #290 step becomes `tally-promotion-adjustments`. After dropping the automatic promotions' adjustments, it:
  - adds one line-item adjustment per priced line, with `code`, `promotion_id`, `amount`, and `is_tax_inclusive` from the line's mode. The amounts are the till's, as matched in the pre-flight, never a fresh price;
  - links the order to each promotion (Medusa's order–promotion link);
  - runs `registerUsageStep`, whose `revertUsage` compensation undoes the usage if a later step fails.

  The same step also runs on the resume path (`resume.ts`) before a draft that is still a draft is converted, so a crash between create and convert can't leave Medusa's prices on the order (#291 review).

  `createOrderWorkflow` still gets no `promo_codes`. Its refresh would re-price from the order's gross item subtotals, ignoring the till's discounts, and would replace these adjustments.
- **A race.** A use can be taken between the pre-flight and the write. That is the one refusal raised after the claim, and the only thing atomic enough to catch it is `registerUsage` itself, inside the workflow.
  - `registerUsage` throwing `NOT_ALLOWED` maps to a new error class.
  - `execute.ts` turns it into `coupon_invalid` with `limit_reached` or `budget_exceeded`, the same path a `StoreConfigurationError` takes today.
  - The workflow rolls back, and the ledger records the command as `rejected`.
  - No order and no payment are stored, so this condition still holds: nothing is ever stored at a total other than the one charged.
- **Usage is registered exactly once per order** (desk condition, 2026-11-11).
  - The ledger claim on the command id means a replay of an applied command returns the recorded result without running the workflow, so it can't register again.
  - A transient failure after `registerUsageStep` compensates with `revertUsage` before the command is retried, so the retry registers once.
  - The implementation's integration tests prove both: the same command sent twice, and a failure injected after the step followed by a retry. Each must leave the promotion's usage at 1.
- **Cancel and refund don't return the use** (desk condition, 2026-11-11). This matches Medusa's own flow.
  - In Medusa 2.21.0, `revertUsage` runs only as the compensation of `registerUsageStep` inside `completeCartWorkflow`.
  - `cancelOrderWorkflow`, returns and refunds never revert promotion usage. No core-flows file other than `register-usage.js` and `complete-cart.js` references it.
  - So a cancelled or refunded POS order keeps its use, like a storefront order. That includes the plugin's own cancel in `scripts/tally-ledger-resolve.ts`.
  - If Medusa later reverts usage on cancel, POS orders follow through the same workflow, and this ADR is revisited.

**Why:** Medusa stays the source of truth for rules, usage and budgets (the Medusa way), and the order carries real promotion links and usage. The till's figures remain the fiscal record, checked against the store's own computation, never silently replaced.

### 3. The first cut covers standard promotions that target items
Promotions of type `buyget`, and promotions targeting `shipping_methods` or the whole `order`, are refused at preview and at create with `not_applicable`. The message is "This coupon can't be used at the till yet". The cashier sees it at preview, and on the refused order if one slipped through.
- TallyUI #709 carries per-line amounts only, so a shipping-method coupon has nowhere to go.
- Buy-get pricing is still per-line, but it needs its own test of quantities and of which items are free.

Widening this is a later decision, made per type.

### 4. Refusals
- The code is `coupon_invalid`, with data `{ couponCode, storeCode }`.
- `storeCode` is one of: `not_found` (no such code, or a `couponId` mismatch), `not_active` (draft, expired or outside its campaign), `not_applicable` (rules, currency or customer don't match, or decision 3), `limit_reached`, `budget_exceeded`, `amount_mismatch`.
- `computeActions` drops inactive and non-matching codes silently, so `priceCoupons` looks the code up itself to tell `not_found`, `not_active` and `not_applicable` apart.
- Each message is a cashier sentence.
- The till already treats `coupon_invalid` as not requeueable and reopenable (TallyUI `order-outbox.ts`, `reopen.ts`), so no till change is needed.

### 5. Contract and capability
- No new `order.create` version: coupons ride v6 and v7, with `couponId` set to the Medusa promotion id.
- `/tally/v1/info` advertises `coupons: true` only from the plugin release that applies coupons.
- The refusal stays as the backstop for an older plugin behind a newer till (the ADR 0021 pattern).

## Consequences
- **This plugin:**
  - a new public route (one-way: the plugin API), the `priceCoupons` function, the pre-flight in `process.ts`, the widened #290 step, a new error class and the capability;
  - integration tests for each `storeCode`, the usage rollback, and preview equal to create.
- **The app,** at the TallyUI 3.19.0 bump:
  - `createStorePricedDiscountCodes` with a `price()` that calls the preview;
  - a coupon field in the cart's `afterSubtotal` slot;
  - `coupons` persisted in the session's capabilities.
- **Before implementation, a probe must confirm** that adjustments written between `createOrderWorkflow` and `convertDraftOrderWorkflow` are counted in the converted order's totals, as they appear to be under #290, and that `registerUsageStep` can run from a plugin workflow.
- Until the next ADR, coupons need a connection, and shipping, order-level and buy-get promotions are refused at the till.
