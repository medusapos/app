# Cart and receipt totals come from TallyUI's order.display

Status: Accepted
Date: 2026-09-25

## Context

TallyUI's settlement subtotal is already after every discount, and its
`discountMinor` mixes each line's own tax mode, so #63 showed Subtotal, VAT
and Total with "Includes discounts of …" as a note outside them. TallyUI
ADR-063 added `order.display`, figures in the store's display mode that add up.

## Decision

- Cart and receipt show Subtotal, Discount (above 0), VAT and Total from
  `order.display`, via `buildReceiptData`'s totals (its tax split by rate);
  the cart through TallyUI's `CartTotal`. Exclusive: subtotal − discount +
  VAT = total. Inclusive: subtotal − discount = total, "incl. VAT x%", not
  added.
- The app never does totals arithmetic; a wrong figure is fixed in TallyUI.
- Supersedes #63's "Includes discounts of …" note. Settlement figures and
  `order.create` are unchanged.

## Line figures (TallyUI #132, 2026-09-25)

Each line shows its display amount before any discount (`order.display.lines`,
the receipt's `displayAmountMinor`), with its own discounts as sub-rows: in the
cart a removable chip with its amount ("10% −€0.40"), on the receipt a
"10% off" row. The order discounts are one "Order discount" row
(`orderDiscountMinor`); one order discount's chip carries it, several keep
their own labels. The line amounts add up to the Subtotal, and the sub-rows
plus the order row to the Discount. This replaces the post-discount line
totals (`netMinor`, `lineTotalMinor`) and the receipt's "· 10% off"
description suffix. The tax reads "incl. VAT x%" above the Total when
inclusive, via `CartTotal`'s `taxInclusive`.
