# POS totals are the fiscal record

Status: Accepted
Date: 2026-09-25

## Context

Medusa computes tax unrounded and never stores the order total: `raw_total`
is recomputed on every read (for example 3.875), while the till captures its
own rounded total (3.88, TallyUI ADR-037). Medusa treats any gap below one
minor unit as settled — `pending_difference` is zeroed, and the admin shows
€3.88 total with €0.00 outstanding. No native Medusa mechanism can make the
stored total exactly equal to the till's.

## Decision

The POS receipt figures (recorded as `tally_pos_totals`) and TallyUI's frozen
X/Z closures are the fiscal figures. Medusa's `raw_total` and `tax_total` are
not; Medusa keeps unrounded tax and settles within one minor unit.

## Evidence

Medusa 2.21.0, paths under `node_modules/@medusajs/`:

- totals are recomputed on read: `order/dist/utils/transform-order.js:79`,
  `order/dist/services/order-module-service.js:155-189`;
- unrounded tax: `utils/dist/totals/tax/index.js:12-19`,
  `utils/dist/totals/line-item/index.js:47-92`;
- `pending_difference` is zeroed within one unit:
  `utils/dist/totals/cart/index.js:154-161`,
  `utils/dist/totals/big-number.js:140-146`;
- credit lines are refused or ignored within one unit:
  `core-flows/dist/order/workflows/create-order-credit-lines.js:15-23`,
  `utils/dist/totals/credit-lines/index.js:37-43`;
- tax lines are rate-only: `order/dist/models/line-item-tax-line.js:12`.

## Options considered

- (a) A credit line for the gap: impossible, refused or ignored within one
  minor unit.
- (b) A tax line carrying the gap: impossible, tax lines store rates only.
- (c) Capture `raw_total` instead of the till's total: makes the payment
  records wrong.
- (d) A rounding line item: exact, but adds a line without a variant to most
  tax-exclusive orders and still doesn't match the POS tax.
- **(e) Record the till's figures as order metadata, and leave Medusa's
  totals alone: chosen.**

## Consequences

Reports read `tally_pos_totals`, not `raw_total`, for the fiscal figures.
`display` and `taxByRate` arrive with `order.create` version 3 (TallyUI
ADR-065), not in this job. `total_mismatch` still flags real gaps (half a
minor unit or more).
