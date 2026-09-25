# The cart, cart bar, tender and discount components come from @tallyui/components

Status: Accepted
Date: 2026-09-25

## Context

`apps/expo/components/cart.tsx`, `cart-bar.tsx`, `tender.tsx` and
`discount-form.tsx` were the app's own copies of the sale screen's cart,
cart bar, tender and discount UI, built on TallyUI's `useSale` (TV5) and its
`CartLine`/`CartPanel`/`CartTotal`/`CartLineActions`/`DiscountBadge`/
`CashTendered`/`ChangeDisplay` primitives, but living outside the package.
TallyUI lifted them into `@tallyui/components` (TallyUI ADR-052/064, TV6a,
#139): `Cart`, `CartBar`, `Tender`, `DiscountForm`, `DiscountChips`,
`parseDiscount` and `discountLabel` are now exported from the package root,
unchanged apart from internal imports and ADR-064's rule that components
import only types and allow-listed pure functions from `@tallyui/pos`.

`Cart` isn't universal about tax naming, so it takes an optional
`taxLabel?: (ratePpm: number) => string`, defaulting to `Tax n%`; the app
passes its own `` `VAT ${ppm / 10000}%` `` so the cart and receipt keep
reading "VAT 25%".

## Decision

- The app imports these names from `@tallyui/components` instead of keeping
  its own copies. `components/cart.tsx`, `cart-bar.tsx`, `tender.tsx` and
  `discount-form.tsx` are deleted.
- `app/index.tsx` passes `taxLabel={(ppm) => \`VAT ${ppm / 10000}%\`}` to
  `Cart`. `components/receipt.tsx` imports `discountLabel` from the package.
- The screen tests (`tests/sale.test.tsx`, `tests/discount.test.tsx`) are
  unchanged apart from their imports and their `vi.mock('@tallyui/components')`
  partial mocks, which now spread the real `Cart`/`CartBar`/`Tender`/
  `DiscountForm`/`DiscountChips` (via the package's own `sale` submodule,
  since `importOriginal` on the whole barrel still fails under vitest) and
  mock the primitives those components use internally (`../cart`,
  `../checkout`) by their resolved path, since those are no longer reachable
  through a `@tallyui/components` barrel mock once the sale components live
  inside the package. They remain the end-to-end proof that the screens
  still behave.
- `components/print-style.ts` keeps its own `dataSet` augmentation for now;
  TV6b, which lifts the print-style hook itself, makes it redundant.
- The app keeps only screens and wiring. Fixes to the cart, cart bar, tender
  or discount UI go to TallyUI, not here.

## Consequences

- No behaviour, figure, label or layout changes; this is an import move plus
  one explicit `taxLabel` prop.
