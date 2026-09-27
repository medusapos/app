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

The sign-out hold on TallyUI's `savesInFlight` (in `SessionProvider`), the visible "An earlier sale is still being saved." note and the backstop's `ORDER_STORE_CLOSE_TIMEOUT` code are done (ADR 0015). Two smaller items remain.

- **A Reload hint on the earlier-sale note once storage reports a stall.** A write that never answers keeps Sign out locked until Reload, and the note doesn't say so.
- **Consider gating the tender's Complete on `orders !== null`,** so a sale can't be paid while the order store is still opening.

From the #86 review:
- **Show the earlier-sale note off the sale screen.** The store-settings screens (choose, unsupported, error, loading) show neither the note nor Sign out, so a sign-out held by a save that never answers looks like nothing is happening. Render the note above `PricingScreen` whenever `savesInFlight > 0`. Ideally, fold this into the Reload hint above.
- **Note wording.**
  - On a receipt, "You'll be signed out once it's saved." leaves out that an automatic sign-out also waits for New sale.
  - Once the earlier save settles, "Signed out after this sale is saved" shows on a sale that's already saved.
  - While `sale.saving`, it leaves out an earlier save still in flight.
  - Branch on the receipt stage, or use a generic "You'll be signed out once saving finishes."
- **Update the hold comment in `app/index.tsx`** (~194-196): a pending sign-out is also run by `OutboxProvider`'s release, as ADR 0015 now says.
- **Add a session-context test for the receipt hold plus the saves hold:** the saves hold releasing on `'receipt'` must not run an automatic deferred sign-out, and New sale then runs it once.
