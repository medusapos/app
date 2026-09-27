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

## Saves in flight after Continue: follow-ups (from the #85 re-review)

Do these at the pin that brings TallyUI's `useOrderOutbox().savesInFlight`, which replaces the app's own count in `OutboxProvider`.

- **Move the in-flight hold into `SessionProvider`.** Today the sale screen sets it, so a store-settings screen that unmounts the sale after Continue lets an automatic sign-out run while a save is in flight. The 10 s backstop then shows #80's prompt. ADR 0015 records this gap.
- **Show why Sign out is locked.** "An earlier sale is still being saved." is only an accessible description. A sighted cashier sees a dimmed Sign out and nothing else, and a write that never answers keeps it locked until Reload. Show it visibly while `savesInFlight > 0 && !sale.saving` (the banner slot), with a Reload hint once storage reports a stall. The deferred sign-out banner also says "this sale" when it means an earlier one.
- **Give the backstop error a `code`** (`ORDER_STORE_CLOSE_TIMEOUT`), so #80's prompt and Report a problem can tell it apart.
- **Consider gating the tender's Complete on `orders !== null`,** so a sale can't be paid while the order store is still opening.
