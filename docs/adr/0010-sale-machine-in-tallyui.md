# The sale machine, cart and catalogue helpers come from @tallyui/pos

Status: Accepted
Date: 2026-09-25

## Context

`apps/expo/lib/use-sale.ts`, `lib/cart.ts` and `lib/catalogue.ts` were the
app's own copies of the sale state machine and its cart and catalogue
helpers, built on TallyUI's order builder and tax context but living outside
the package. TallyUI lifted them into `@tallyui/pos` (TallyUI ADR-052, TV5,
#138): `useSale`, `SaleStage`, `DISCOUNTS_UNSUPPORTED`, `addEntryToCart`,
`CartError`, `CatalogueEntry`, `catalogueEntries`, `findEntryByCode` and
`variantPriceLabel` are now exported from the package root, unchanged apart
from internal imports and a new optional `session` option on `useSale` that
the app does not use.

## Decision

- The app imports these names from `@tallyui/pos` instead of keeping its own
  copies. `lib/use-sale.ts`, `lib/cart.ts` and `lib/catalogue.ts` are deleted.
- `lib/cart.test.ts` is deleted: TallyUI's `packages/pos/src/sale/cart.test.ts`
  covers the same cases. `lib/catalogue.test.ts` stays — TallyUI has no
  catalogue test — with its imports pointed at `@tallyui/pos`.
- The screen tests (`tests/sale.test.tsx`, `tests/discount.test.tsx` and the
  rest) are unchanged apart from imports; they remain the end-to-end proof
  that the screens still behave.
- The app keeps only screens and wiring. Fixes to the sale machine, the cart
  helper or the catalogue helpers go to TallyUI, not here.

## Consequences

- No behaviour, figure, label or layout changes; this is an import move.
- A duplicate test suite (the ported `cart.test.ts`) is gone from this repo's
  vitest count; TallyUI runs it instead.
