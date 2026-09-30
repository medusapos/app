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
The plugin advertises `taxRounding: per_order / half_away_from_zero` on
`/tally/v1/info` (TallyUI #309, ADR-071): Medusa never rounds totals, tax
providers return rates only (`types/dist/tax/common.d.ts:440-486`),
`majorToMinor` rounds `raw_total` once (`money.ts:15-32`), and #133 found 0
differences in 340,230 sales.

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

  Such a sale's result carries `customer_ignored` (TallyUI #266). The warning
  compares the order's `customer_id` with `tally_customer_id`, so resumed or
  re-run orders warn too. Medusa 2.21 has no link between customers and sales
  channels, so only unknown and deleted customers are warned about.

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

**Strictness scope** (amended by ruling 17, 2026-09-30, issue #132): every
object of every command refuses a field its declared version doesn't know,
as unstored `invalid_payload` naming the path (`lines[2].discountMinr:
unknown field for order.create version 1`), after the replay read and
before the claim. A field a later version declares is named with that
version (`display: requires version 3`); envelope fields are strict too.
Keys are free only in the maps the contract declares, `counted` and
`tillExpected`, and those must be a `PaymentMethodKind` (`cash`, `external`).
Every client-time field (envelope `createdAt` and each payload time) must parse and fall from 2020-01-01T00:00:00Z to 24 hours after the server's clock, refused the same way and never clamped (TallyUI #325, ADR-038).
The earlier leniency was an accident: ADR 0004 checked only types and
presence, and #90 kept it out of general caution, for no named client. The
contract types are closed. Under leniency a misspelled optional money field
is ignored silently; under strictness it is refused in plain sight. Every
recorded TallyUI envelope (`@tallyui/pos` 2.0.0 and main, v1 to v3, and the
register commands) passes unchanged, as the plugin's regression fixtures.

**Consequences:**
- The command fingerprint covers the whole payload, so idempotency is
  unchanged. TallyUI fixes each order's version at finalize, so a retry's
  bytes never change.
- A plugin downgraded below version 3 after tills finalized v3 orders
  rejects those orders. TallyUI accepts this, as it does for discounts.
- The plugin can land before TallyUI's half: a till sends v3 only once it
  carries the new fields, which needs capability 3 and TallyUI's v3 release
  pinned by the app.
