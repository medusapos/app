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

## TallyUI's CartPanel needs a list-footer slot

`apps/expo/components/cart.tsx` composes the cart itself (ADR 0009) because
`CartPanel` scrolls only its items: the order discount has to scroll after
the last line, above the pinned footer. A `listFooter` slot inside
`CartPanel`'s scroll area (TallyUI) would let the app use it again.

## A keyboard-wedge scan in the phone cart view has nowhere to land

In phone mode (ADR 0009) the cart view unmounts the catalogue, and with it
the search field that takes scanner input. A hardware (keyboard-wedge) scan
made while the cart is open is dropped: nothing is added and nothing is
shown. Phones mostly scan with the camera, so this is minor; a fix would
route scans to `sale.add` in either view, e.g. a scan listener above both
(from the phone-cart review).

## Tap race when new store settings land

Tap race: a line added at the instant new store settings land is dropped from the cart (nothing is charged); the sale-idle hold should also cover the add that races the swap (from #58 review).

## TALLYUI_REF is pinned to a backport branch

`TALLYUI_REF` pins TallyUI `backport/131-on-e5f540a` (4abbf04): #131's
`addPosOrderCollection` alone on e5f540a, off TallyUI main. #66 (display
totals) moves the pin back to TallyUI main. Keep the backport branch
afterwards, or replace it with a tag on 4abbf04: CI and Vercel fetch the
pinned commit by SHA, so this app's history can only be rebuilt, reverted or
bisected while a TallyUI ref still holds that commit (from #68 review).
