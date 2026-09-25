# App backlog

## The open variant chooser doesn't refresh live

`Catalogue` (`apps/expo/components/catalogue.tsx`) stores the chooser's
entries in `choices`, a snapshot taken when it was opened. A stock reconcile
that lands while the chooser is already open doesn't update it — the cashier
has to close and reopen it to see the new status. The chooser should read
live entries (e.g. re-derive `choices` from `entries` instead of snapshotting
them) so it reflects reconciled stock while it's open.

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

## Half-cent gap between Medusa's order total and the captured payment

Plugin, low priority. Half-cent gap: Medusa stores an unrounded order total
(e.g. 3.875) while the POS captures the rounded amount (3.88) when the tax
works out to half a cent (ADR-037); the order shows a 0.005 difference
between its total and the captured payment.

## 360 px cart layout after a discount

UI, next after discounts. 360 px cart layout: after a discount, the chips,
the Order discount button and the totals push the cart lines out of view in
the bottom half of a phone screen (the tester's main surface).

## Tap race when new store settings land

Tap race: a line added at the instant new store settings land is dropped from the cart (nothing is charged); the sale-idle hold should also cover the add that races the swap (from #58 review).
