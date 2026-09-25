# Phone sale layout

Status: Accepted
Date: 2026-09-25

## Context

The phone is the tester's main surface. Below 900 px the sale screen stacked
the catalogue and the cart 50/50, and TallyUI's `CartPanel` scrolled only the
lines under a pinned footer that held the order discount chips, the "Order
discount" button or form, the totals, the error and two full-width pay
buttons. In the bottom half of a 360 × 740 screen that footer left the lines
almost no height, so after a discount they were pushed out of view.

## Decision

**Phone mode, below 600 px window width.** The sale screen has two
full-height views and no split:

- **Products** (the default): the catalogue and sync status, with a cart bar
  pinned at the bottom. The whole bar is one button, at least 56 px tall:
  "Cart · 2 items" on the left (the sum of line quantities, "1 item" when
  singular) and the cart's own Total on the right, from the same
  `buildReceiptData` totals. Its label reads "Open cart, 2 items, €3.88", or
  "Cart is empty" and disabled. Adding a product, by tap or scan, stays on
  Products so scanning continues.
- **Cart**: a "Products" back button (at least 44 px) above the cart at full
  height. Going back never changes the sale.

While the sale is in tender, the Tender screen replaces either view at full
height. The receipt is unchanged, and a new sale starts on Products.

**The cart, at all widths.** Scrollable: the lines, then the order discount
section (its chips, the "Order discount" button or its open form) directly
after the last line. Pinned footer: the totals block as it was ("Includes
discounts of …" and `CartTotal`), the sale error, and Cash and Card terminal
side by side, each at least 48 px tall.

The cart uses TallyUI's `CartPanel` with its `afterItems` slot (TallyUI
#136) for the order-discount section. The earlier composition existed only
for the missing slot: the footer was always pinned, and react-native-web
gives every `View` `minHeight: 0`, so no app-side layout cause existed.

From 600 px the existing split stays (a column below 900 px, a row from
900 px), with the new cart structure.

## Consequences

- On a phone the lines, the Total and the pay buttons are always visible
  together; a long order discount form scrolls with the lines instead of
  squeezing them.
- The catalogue unmounts while the phone shows the cart, so its search text
  and scroll position reset on the way back; the sale itself never does.
- The totals block moved unchanged, so its later replacement (#66) is a
  like-for-like swap in the footer.
- `e2e/phone-cart.spec.ts` runs at 360 × 740; the other specs stay at
  Desktop Chrome. Unit tests set the jsdom window width, which otherwise
  reads 0, that is, phone mode.
