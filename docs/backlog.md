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

## The bundle check doesn't fail closed

`scripts/check-web-bundle.sh` rejects debug hooks by their `__medusapos`
prefix. So a hook renamed without the prefix passes, and a grep read error
(exit 2) counts as clean. Route every E2E debug export through one named
module and check for that module instead of the prefix, and treat any grep
exit other than 0 or 1 as a failure (from #64 review).

## pos_orders migration recovery after a DM4

TallyUI, no app change. After a DM4, RxDB 16.21 keeps an error migration
status, so recovery takes an extra reload. On SQLite, an open can also close
the database mid-migration. A stale "done" status after a rollback and
re-upgrade can open the store before newly written sales have migrated.
TallyUI will reset a leftover error or stale done status inside
`posOrderCollection()`. Pin that SHA when it lands (from #64 review).
