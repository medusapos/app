# order.create v5 on Medusa: fees, shipping and custom lines

Status: Accepted
Date: 2026-10-06

## Context

TallyUI ADR-075 (accepted 2026-10-06) adds `order.create` version 5: version 4 plus three additions.
- **Top-level `fees[]`:** `clientFeeId`, `name`, `amountMinor` in the order's tax mode, `taxStatus` (`'taxable'` or
  `'none'`), `taxClass?` and `taxMinor`.
- **Top-level `shipping[]`:** the same fields, with `clientShippingId` and a recorded `methodId?`.
- **`lines[].custom`:** a line not from the catalogue, with no `variantId`. It carries `name`, `sku?`, `taxClass?` and
  `taxStatus`.

A till sends v5 only for an order that carries one of these. The contract and its golden pairs are in
`~/agent/handoff/tallyui-order-create-v5-2026-10-06.md`. ADR-070 makes every instruction field honoured or refused,
never ignored.

**What Medusa 2.21 offers.** This was read from the installed source, with a Codex second opinion, in
`~/agent/handoff/medusapos-v5-tax-exempt-ruling-2026-10-06.md`.
- `createOrderWorkflow` takes items with no `variant_id` (`title`, `unit_price`, `quantity`, `is_tax_inclusive`,
  `requires_shipping`, metadata) and native `shipping_methods`.
- Fulfilment handles variant-less items, which need no inventory reservation.
- Tax lines come from the tax module on create and on every later tax refresh (order edits, claims, exchanges). The
  system provider applies the region's rate to anything with no product or shipping-option rule.
- **No per-line exemption survives a refresh.** Neither `tax_lines: []` nor an explicit 0% line does.
- Medusa has no tax classes.

## Decision

1. **Advertise 5.** `GET /tally/v1/info` lists `order.create: [1, 2, 3, 4, 5]`. It also adds the line-tax capability
   TallyUI agreed (handoff §1b): a top-level `lineTax: { none: false, classes: false }`. TallyUI hides tax-free
   charges and tax classes for this store before the push.
2. **A fee** becomes a variant-less line item:
   - quantity 1, `title` = `name`, `unit_price` = `amountMinor` in major units;
   - `is_tax_inclusive` = the order's `pricesIncludeTax`;
   - `requires_shipping: false`, `is_discountable: false`;
   - metadata `{ tally_fee_uuid }`.
   
   It takes no discount, as the contract says.
3. **A shipping charge** becomes a native order shipping method:
   - `name`, `amount` in major units, `is_tax_inclusive` = `pricesIncludeTax`;
   - metadata `{ tally_shipping_uuid, tally_method_id? }`;
   - no `shipping_option_id`: `methodId` is recorded, not mapped.
4. **A custom line** becomes a variant-less line item:
   - `title` = `custom.name`, `variant_sku` = `custom.sku`, with the line's quantity, unit price and tax mode;
   - metadata `{ tally_line_uuid }`;
   - its net discount adjustment, as any v4 line.
   
   It joins the non-shipping fulfilment group.
5. **Refusals.** All are `invalid_payload`, naming the path, in the Vendure plugin's form:
   `message: '<path>: <reason>: …'` and `data: { reason, path }`.
   - `taxStatus: 'none'` on a fee, shipping charge or custom line: reason `tax_status_unsupported`. Medusa can't keep
     one line tax-free (Context).
   - Any `taxClass`: reason `tax_class_unknown`. Medusa has no classes.
   - Any v5 field below version 5: "requires version 5", as for every versioned field.
   - A custom line with a `variantId`, or a non-custom line without one.
   - A negative or non-integer amount.
6. **Figures.** `tally_pos_totals` records the payload as sent, now including `fees`, `shipping` and the v5 `display`.
   - Medusa's order total includes the charges, so `total_mismatch` keeps comparing totals.
   - `figures_mismatch` compares the till's product subtotal with the server's item subtotal less fees and shipping.
     Charges never count as a subtotal difference.
7. **Idempotency is unchanged.** `clientFeeId`, `clientShippingId` and `clientLineId` are stable per order, so a replay
   carries the same payload fingerprint and answers as the original did.

## Consequences

- A Medusa store takes taxable fees, shipping and custom lines from the till. Golden pair §3.1 (a 0.20 bag fee)
  applies at 12.24.
- **Golden pair §3.2 is a "refused" pair on Medusa.** Its tax-free gift wrap is `invalid_payload` naming
  `payload.lines[1].custom.taxStatus`. The same order with a taxable gift wrap applies.
- Tax-free charges on Medusa would need a plugin tax provider that honours a per-line flag on every calculation, which
  each store would then have to select per region. That's later work, if Paul wants it.
- `lineTax` changes only when that provider exists.

## Rulings

- **Front desk, 2026-10-06:** option (a); reasons `tax_status_unsupported` and `tax_class_unknown`; the `lineTax`
  capability, with the server refusal as the backstop.
- **TallyUI lane, 2026-10-06:** agreed the `lineTax` shape (handoff §1b).
