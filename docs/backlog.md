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

## Barcode wedge thresholds as store settings

`apps/expo/lib/use-wedge-scan.ts` has its average-key-time, stale-gap and
minimum-length thresholds as constants (`WEDGE_AVG_KEY_MS`,
`WEDGE_STALE_GAP_MS`, `WEDGE_MIN_CHARS`). WCPOS mirrors the first two as
per-store settings (`barcode_scanning_avg_time_input_threshold`,
`barcode_scanning_min_chars`); once this app has settings, do the same here.

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
