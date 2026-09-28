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

## Amendment: order.create version 3 (2026-09-28)

TallyUI ADR-065 adds `order.create` version 3, and the plugin accepts it
(`/tally/v1/info` lists `[1, 2, 3]`). Version 3 is version 2 plus up to four
optional fields, each validated by the plugin:

- **`display` and `taxByRate`** (both or neither): the receipt's own figures,
  copied from the till's order snapshot and never recomputed.
  - They're strict: an unknown key anywhere inside `display`, its lines, their
    discounts, or a `taxByRate` entry is rejected as `invalid_payload`.
  - They're consistent: integer minor units; `display.currency`, `totalMinor`
    and `taxMinor` equal the payload's; Σ `taxByRate.taxMinor` equals
    `taxMinor`; each `grossMinor` is `netMinor + taxMinor`; every
    `display.lines[].clientLineId` names a payload line; and
    `display.exponent` matches the plugin's decimals for the currency.
  - **Stored:** `tally_pos_totals` becomes `{ v: 2, currency, exponent,
    settlement, display, taxByRate }`, with both stored value-identical to
    what was sent (never recomputed; Postgres `jsonb` may reorder keys). They
    are the fiscal figures (this ADR's decision (e)).
  - Orders without them (v1, v2, and v3 without the fields) keep the
    byte-identical `v: 1` shape.
- **`sessionId`:** the register session the sale was taken for. It's a soft
  reference of 1 to 36 characters that's never looked up, and it's stored as
  `tally_session_id`. There is deliberately no `lateSessionId` on the wire: a
  second field would change a resent command's bytes after TallyUI's orphan
  sweep and trip `idempotency_mismatch`.
- **`customer.customerId`** (programme item 14): the Medusa customer picked
  at the till. It's a soft reference of 1 to 64 characters. When the customer
  exists, the draft order gets its `customer_id` and not the till's email:
  Medusa replaces the customer when both an id and a different email are
  given, so the found customer keeps its own email. When it doesn't exist,
  the till's email is used as before. The id is always recorded as
  `tally_customer_id`, and an unknown or deleted customer never fails the
  sale.

**Version rules** (all rejected as `invalid_payload`):
- `display`, `taxByRate`, `sessionId` or `customerId` on version 1 or 2;
- a v3 carrying only one of `display` and `taxByRate`;
- version 2 without `discountMinor`, as before.

A discount-free v3 carries no `discountMinor`, and that's valid at v3.

**Unsupported versions** (any positive integer not in `/tally/v1/info`) are
rejected per command as `unsupported_version`, with
`error.data.orderCreate` set to the highest supported version (a number,
the maximum of `/info`'s list), so the rest of the batch still applies.
TallyUI resends at that version when it's a safe positive integer, and
refreshes `/info` otherwise. The check runs before the ledger records the command,
so a rejected id can be resent at a supported version without
`idempotency_mismatch`. Plugins released before this amendment answer the
whole batch with HTTP 400 instead; TallyUI must handle both.

**Strictness scope:** only the new v3 objects reject unknown keys. The
payload's top level stays as lenient as before, because tightening it could
reject tills already in the field.

**Consequences:**
- The command fingerprint covers the whole payload, so idempotency is
  unchanged. TallyUI fixes each order's version at finalize, so a retry's
  bytes never change.
- A plugin downgraded below version 3 after tills finalized v3 orders
  rejects those orders. TallyUI accepts this, as it does for discounts.
- The plugin can land before TallyUI's half: a till sends v3 only once it
  carries the new fields, which needs capability 3 and TallyUI's v3 release
  pinned by the app.
