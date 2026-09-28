# App backlog

## A multi-variant product's tile price isn't deterministic

The tile shows one variant's price, but variant order isn't stable between
seeded runs (E2E product 4 reads €10 or €11 in the e2e screenshots). Tracked
in TallyUI's backlog: a multi-variant tile will show "from &lt;lowest
price&gt;" when variants differ, and connectors will return variants in a
stable order (by id). Nothing to fix in this app.

## A token refresh restarts catalogue sync

`useReplicatedProducts` (`apps/expo/lib/use-replicated-products.ts`) lists
`headers` in its effect's dependencies, so each token refresh tears the
effect down and starts it again: replication, the stock runner and the id
reconcile runner. The restart runs another id-reconcile start pass, which
costs one extra ids read a day. That's harmless, but it could be avoided by
reading the current headers through a ref instead of restarting on each
refresh.

## Screen tests stub TallyUI primitives through deep aliases

The screen tests use the real TallyUI components (`importOriginal()`), but stub
the primitives those components compose (`CartPanel`, `CartTotal`,
`CashTendered`, …) and assert against the stand-ins. To reach them,
`vitest.config.ts` aliases `@tallyui/components/{cart,checkout,product,input,ui}`
to TallyUI's internal submodules, so a TallyUI refactor of those folders breaks
the app's tests in one place. Moving the assertions onto the real primitives
(or TallyUI exporting those subpaths) would drop the aliases (from the TV6b
review).

## Tap race when new store settings land

Tap race: a line added at the instant new store settings land is dropped from the cart (nothing is charged); the sale-idle hold should also cover the add that races the swap (from #58 review).

## Register part B follow-ups (from the #89 re-review)

- **Register close state isn't reset per store:** `RegisterProvider`'s shown closure and `closeError` aren't reset when the store key changes or on sign-out. On native (on web, LiveTabGate remounts the provider), store A's close error could show above store B's Finish closing card. Reset them on `storeKey`, or key the provider by it.
- **A test hold leaks on failure:** the register-screen no-card test holds a closure write, and doesn't release it in `finally` when the test fails. TallyUI's module-level in-flight close then makes later tests in the file join the stuck close, which gives misleading failures.
- **The "Finish closing" wording:** "Close not finished" is the "The last close didn't finish" state. Keep the tester guide's wording in step with TallyUI's pill and card copy.
- **Also "1 products":** the catalogue status reads "1 products" for a single product (pre-existing).

## Swap the plugin's local order.create v3 types for @tallyui/core

`packages/medusa-plugin/src/workflows/tally-order-create/fiscal-figures.ts` holds local copies of TallyUI's v3 wire types (`OrderCreateDisplay`, `OrderCreateTaxRate`, `OrderCreatePayloadV3`), each marked `BRIDGE`, because `@tallyui/core` doesn't export them yet. TallyUI's order.create v3 ships in `@tallyui/*` 2.1.0. At that bump:
- import the types from `@tallyui/core`;
- delete the local copies;
- check that `__fixtures__/order-create-v3.json` (the golden envelope TallyUI also pins) still passes unchanged.
