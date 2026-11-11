# order.create v6 and v7 on Medusa: the sale's note

Status: Accepted
Date: 2026-11-11

## Context

v2 parity row 8 (`docs/v2-parity/AUDIT.md`, the order sheet's note) is the next row a cashier notices. `@tallyui/pos`
3.17.0 already carries the note: `useSale().setNote` keeps it on the open sale, and `@tallyui/components` `Receipt`
shows it, flagged "not sent" when the store did not take it (`noteDelivery`).

The note travels only as `order.create` version 7 (TallyUI ADR-083, `@tallyui/core` `OrderCreatePayload.note`):
- It is 1 to `ORDER_NOTE_MAX` (1000) UTF-16 units.
- The till sends version 7 only for a sale with a note, figures (version 3+) and a store cap of 7 or more. Below that
  cap the note is left off the wire.
- Version 7 is the order's base version plus `note`. The base is 3 or 5, or 6 when the sale has coupons or "Any"
  attribute picks; every other field follows the base.

This plugin advertises `[1, 2, 3, 4, 5]`, so today every note is dropped. Advertising 7 means accepting 6 as well,
because 7 includes 6's fields. Version 6 (TallyUI ADR-077) adds:
- `coupons[]`: `code`, `couponId`, `discountMinor`, `discountTaxMinor`. These are instructions: the store re-applies
  each coupon by `code`, or refuses the order with `coupon_invalid`.
- Three recorded line fields: `lines[].regularUnitPriceMinor`, `lines[].attributes` (name → value, each at most 255
  characters) and `lines[].anyAttributes` (names in `attributes`).
- `display.coupons[]` (`code`, `amountMinor`), recorded alongside `coupons`.

ADR-070 still holds: every instruction field is honoured or refused, never ignored.

**What this app sends.** The app has no coupon entry; coupons are parity row 7, which needs Medusa promotion codes.
Medusa variants define every option, so the TallyUI variant chooser makes no "Any" picks. So the app sends 6's base
only once row 7 lands, and every note sale goes as 7 over base 3 or 5.

## Decision

1. **Advertise 7.** `GET /tally/v1/info` lists `order.create: [1, 2, 3, 4, 5, 6, 7]`. A version-1 to version-5 command
   is checked and planned exactly as before.
2. **Versions 6 and 7 carry 5's fields** (fees, shipping, custom lines, the v5 display and the line-tax refusals) with
   5's rules. Every check gated on version 5 applies from version 5 up.
3. **Coupons are refused.** A v6 or v7 order with a non-empty `coupons` or `display.coupons` is rejected with
   `coupon_invalid`: this store does not apply till coupons yet. The rejection comes before the claim, and nothing is
   stored. Row 7 replaces this refusal with Medusa promotions.
4. **Recorded line fields are kept** on the order's line item metadata, beside `tally_line_uuid`:
   - `tally_regular_unit_price_minor`, a non-negative safe integer;
   - `tally_attributes`, an object of strings, each at most 255 characters;
   - `tally_any_attributes`, strings, each a key of the line's `attributes`.
   They are checked for shape, and none of them changes a price.
5. **The note.** Version 7's `note` is a string of 1 to 1000 UTF-16 units with no NUL. It is stored as the order's
   `metadata.tally_note`, which Medusa Admin shows in the order's Metadata section. The note is part of the payload,
   so the idempotency fingerprint covers it as it is. A note on a version-6-or-lower command is refused as
   `payload.note: requires version 7`, as for any later field.

## Consequences

- A cashier's note reaches the Medusa order, and the till's receipt no longer flags it "not sent".
- Medusa has no order notes of its own, so the note lives in metadata. An admin widget that shows it is separate work.
- A till that sends coupons to this store gets each such order refused rather than discounted silently. That cannot
  happen until row 7 ships.
