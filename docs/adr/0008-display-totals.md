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
  VAT = total. Inclusive: subtotal − discount = total, "Includes VAT x%" under
  it, not added.
- The app never does totals arithmetic; a wrong figure is fixed in TallyUI.
- Supersedes #63's "Includes discounts of …" note. Receipt lines keep their
  "· 10% off" labels; settlement figures and `order.create` are unchanged.
